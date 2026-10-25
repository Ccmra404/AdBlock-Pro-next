package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var errDNSRollback = errors.New("DNS 设置应用失败，原配置恢复未确认；恢复点已保留，将尝试解除本模块接管以保护联网")

// Only these four fields are editable. Never round-trip the full DNS/API config.
type dnsSettings struct {
	Upstream  []string `json:"upstream_dns"`
	Bootstrap []string `json:"bootstrap_dns"`
	Fallback  []string `json:"fallback_dns"`
	Mode      string   `json:"upstream_mode"`
}
type dnsInfo struct {
	dnsSettings
	File string `json:"upstream_dns_file"`
}
type dnsSnapshot struct {
	Version int         `json:"version"`
	Config  dnsSettings `json:"config"`
}
type dnsEdit struct {
	Config   dnsSettings `json:"config"`
	Revision string      `json:"revision"`
}
type dnsTestRow struct {
	Server string `json:"server"`
	OK     bool   `json:"ok"`
}
type dnsManager struct {
	endpoint, auth, backup string
	client                 *http.Client
}

func runDNS(action string, input io.Reader, output io.Writer) error {
	switch action {
	case "info", "test", "save", "restore":
	default:
		return errors.New("未知 DNS 操作")
	}
	auth, err := os.ReadFile("/data/adb/adblockpro/admin.auth")
	if err != nil {
		return errors.New("无法读取本地 DNS 接口凭据，请检查核心是否已正确安装")
	}
	m := dnsManager{
		endpoint: "http://127.0.0.1:3000/control", auth: strings.TrimRight(string(auth), "\r\n"),
		backup: "/data/adb/adblockpro/backups/dns-before-change.json",
		client: &http.Client{Timeout: 40 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
	if action == "info" {
		current, err := m.info()
		if err != nil {
			return err
		}
		_, err = os.Stat(m.backup)
		return json.NewEncoder(output).Encode(struct {
			Config   dnsSettings `json:"config"`
			Revision string      `json:"revision"`
			Editable bool        `json:"editable"`
			Backup   bool        `json:"backup_available"`
		}{current.dnsSettings, dnsRevision(current), current.File == "" && validateDNS(current.dnsSettings) == nil, err == nil})
	}
	var edit dnsEdit
	if err := decodeDNS(input, &edit); err != nil {
		return err
	}
	if action == "test" {
		if err := validateDNS(edit.Config); err != nil {
			return err
		}
		rows, err := m.test(edit.Config)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(rows)
	}
	restored := action == "restore"
	if restored {
		file, err := os.Open(m.backup)
		if err != nil {
			return errors.New("没有可读取的 DNS 恢复点")
		}
		defer file.Close()
		var backup dnsSnapshot
		if err := decodeDNS(file, &backup); err != nil || backup.Version != 1 {
			return errors.New("DNS 恢复点无效，未修改当前设置")
		}
		edit.Config = backup.Config
	}
	if err := m.apply(edit, !restored); err != nil {
		return err
	}
	if restored {
		fmt.Fprintln(output, "[成功] 已恢复上次 DNS 配置，DNS 核心继续运行。")
	} else {
		fmt.Fprintln(output, "[成功] DNS 上游设置已保存，DNS 核心继续运行。")
	}
	if err := m.call(http.MethodPost, "/cache_clear", nil, nil); err != nil {
		fmt.Fprintln(output, "[提醒] DNS 配置已生效，但缓存清理未确认，已有缓存可能暂时影响结果。")
	}
	return nil
}

func decodeDNS(r io.Reader, target any) error {
	raw, err := io.ReadAll(io.LimitReader(r, 32769))
	if err != nil || len(raw) > 32768 {
		return errors.New("DNS 设置过大或读取失败")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("DNS 设置格式无效，未执行操作")
	}
	return nil
}
func normalizeDNS(c *dnsSettings) {
	if c.Upstream == nil {
		c.Upstream = []string{}
	}
	if c.Bootstrap == nil {
		c.Bootstrap = []string{}
	}
	if c.Fallback == nil {
		c.Fallback = []string{}
	}
	if c.Mode == "" {
		c.Mode = "load_balance"
	}
}
func dnsRevision(c dnsInfo) string {
	raw, _ := json.Marshal(c)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func validateDNS(c dnsSettings) error {
	if len(c.Upstream) == 0 {
		return errors.New("至少填写一个上游 DNS")
	}
	switch c.Mode {
	case "load_balance", "parallel", "fastest_addr":
	default:
		return errors.New("请选择有效的 DNS 查询模式")
	}
	for kind, servers := range [][]string{c.Upstream, c.Bootstrap, c.Fallback} {
		if len(servers) > 8 {
			return errors.New("每组最多填写 8 个 DNS 地址")
		}
		for _, server := range servers {
			if !validDNSServer(server, kind == 1) {
				return errors.New("DNS 地址格式不支持或会指向模块自身；高级规则请在 AdGuard Home 后台管理")
			}
		}
	}
	return nil
}
func validDNSServer(server string, bootstrap bool) bool {
	if len(server) == 0 || len(server) > 2048 || strings.ContainsAny(server, " \t\r\n\x00") {
		return false
	}
	host, port := server, "53"
	if strings.Contains(server, "://") {
		if bootstrap {
			return false
		}
		u, err := url.Parse(server)
		if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Hostname() == "" {
			return false
		}
		if u.Scheme != "https" && u.Scheme != "tls" {
			return false
		}
		if u.Scheme == "tls" && (u.Path != "" || u.RawQuery != "") {
			return false
		}
		host, port = u.Hostname(), u.Port()
		if port == "" {
			if u.Scheme == "https" {
				port = "443"
			} else {
				port = "853"
			}
		}
	} else if _, err := netip.ParseAddr(server); err != nil {
		host, port, err = net.SplitHostPort(server)
		if err != nil {
			return false
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err == nil {
		if ip.IsUnspecified() || ip.IsMulticast() || ip.Zone() != "" {
			return false
		}
		if ip.Unmap().IsLoopback() {
			return false
		}
	} else {
		if bootstrap || !strings.Contains(server, "://") || len(host) > 253 || !strings.Contains(host, ".") {
			return false
		}
		for _, label := range strings.Split(host, ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return false
			}
			for _, c := range label {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
					return false
				}
			}
		}
	}
	return true
}
func (m dnsManager) call(method, route string, payload, target any) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return errors.New("无法编码 DNS 设置")
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, m.endpoint+route, body)
	if err != nil {
		return errors.New("本地 DNS 接口地址无效")
	}
	user, pass, ok := strings.Cut(m.auth, ":")
	if !ok || user == "" {
		return errors.New("本地 DNS 接口凭据无效")
	}
	req.SetBasicAuth(user, pass)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := m.client.Do(req)
	if err != nil {
		return errors.New("本地 DNS 服务未响应或测试超时，请确认核心运行后重试")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("本地 DNS 接口 %s 返回 HTTP %d，请检查核心及账号配置", route, response.StatusCode)
	}
	if target == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 || json.Unmarshal(raw, target) != nil {
		return errors.New("本地 DNS 服务返回的结果无效")
	}
	return nil
}
func (m dnsManager) info() (dnsInfo, error) {
	var current dnsInfo
	err := m.call(http.MethodGet, "/dns_info", nil, &current)
	if err == nil && current.Upstream == nil && current.File == "" {
		err = errors.New("本地 DNS 服务返回的配置不完整")
	}
	normalizeDNS(&current.dnsSettings)
	return current, err
}

// AdGuard Home returns upstream.Address() keys, including protocol default ports.
func dnsTestResultKey(server string) string {
	if _, err := netip.ParseAddr(server); err == nil {
		return net.JoinHostPort(server, "53")
	}
	u, err := url.Parse(server)
	if err != nil || (u.Scheme != "https" && u.Scheme != "tls") {
		return server
	}
	if u.Port() == "" {
		port := "443"
		if u.Scheme == "tls" {
			port = "853"
		}
		u.Host = net.JoinHostPort(u.Hostname(), port)
	}
	return u.String()
}

func (m dnsManager) test(c dnsSettings) ([]dnsTestRow, error) {
	servers, seen := []string{}, map[string]bool{}
	for _, group := range [][]string{c.Upstream, c.Fallback, c.Bootstrap} {
		for _, s := range group {
			if !seen[s] {
				servers = append(servers, s)
				seen[s] = true
			}
		}
	}
	var results map[string]string
	if err := m.call(http.MethodPost, "/test_upstream_dns", map[string]any{"upstream_dns": servers, "bootstrap_dns": c.Bootstrap}, &results); err != nil {
		return nil, err
	}
	rows := make([]dnsTestRow, 0, len(servers))
	for _, s := range servers {
		result, exists := results[s]
		if !exists {
			result = results[dnsTestResultKey(s)]
		}
		rows = append(rows, dnsTestRow{s, result == "OK"})
	}
	return rows, nil
}
func (m dnsManager) apply(edit dnsEdit, makeBackup bool) error {
	normalizeDNS(&edit.Config)
	if err := validateDNS(edit.Config); err != nil {
		return err
	}
	current, err := m.info()
	if err != nil {
		return err
	}
	if edit.Revision != dnsRevision(current) {
		return errors.New("DNS 设置已被其他页面修改，请重新读取后再操作")
	}
	if current.File != "" || validateDNS(current.dnsSettings) != nil {
		return errors.New("当前使用高级 DNS 配置，请通过 AdGuard Home 后台修改")
	}
	if makeBackup {
		rows, err := m.test(edit.Config)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if !row.OK {
				return errors.New("至少一个 DNS 地址测试未通过，未修改当前配置；请测试并调整地址")
			}
		}
	}
	// Tests can take seconds. Refuse to overwrite changes made during that time.
	latest, err := m.info()
	if err != nil {
		return err
	}
	if dnsRevision(latest) != edit.Revision {
		return errors.New("测试期间 DNS 设置已变化，请重新读取后再操作")
	}
	if makeBackup {
		if err := saveDNSSnapshot(m.backup, current.dnsSettings); err != nil {
			return errors.New("无法保存私有 DNS 恢复点，未修改当前配置")
		}
	}
	applied := m.call(http.MethodPost, "/dns_config", edit.Config, nil)
	if applied == nil {
		applied = m.verify(edit.Config)
	}
	if applied != nil {
		// An HTTP error can arrive after the server applied part of a request.
		_ = m.call(http.MethodPost, "/dns_config", current.dnsSettings, nil)
		if m.verify(current.dnsSettings) != nil {
			return errDNSRollback
		}
		return errors.New("DNS 设置应用未成功，已恢复操作前配置；请查看网络和核心状态")
	}
	return nil
}
func (m dnsManager) verify(c dnsSettings) error {
	current, err := m.info()
	if err != nil {
		return err
	}
	if dnsRevision(current) != dnsRevision(dnsInfo{dnsSettings: c}) {
		return errors.New("DNS 设置保存后校验失败")
	}
	return nil
}
func saveDNSSnapshot(name string, c dnsSettings) error {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".dns-before-change-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := json.NewEncoder(f).Encode(dnsSnapshot{1, c}); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), name)
}
