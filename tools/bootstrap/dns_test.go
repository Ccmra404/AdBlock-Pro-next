package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func dnsDefaults() dnsSettings {
	return dnsSettings{[]string{"223.5.5.5", "119.29.29.29"}, []string{}, []string{}, "load_balance"}
}

type dnsFixture struct {
	mu                                                                    sync.Mutex
	manager                                                               dnsManager
	current                                                               dnsInfo
	calls                                                                 []string
	badTest, missingTest, changeDuringTest, failFirstWrite, failAllWrites bool
	writes                                                                int
	postFields                                                            []string
	testResults                                                           map[string]string
}

func newDNSFixture(t *testing.T) *dnsFixture {
	t.Helper()
	f := &dnsFixture{current: dnsInfo{dnsSettings: dnsDefaults()}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if u, p, ok := r.BasicAuth(); !ok || u != "test-user" || p != "test-password" {
			t.Error("local API auth missing")
			w.WriteHeader(401)
			return
		}
		f.calls = append(f.calls, r.URL.Path)
		switch r.URL.Path {
		case "/dns_info":
			json.NewEncoder(w).Encode(f.current)
		case "/test_upstream_dns":
			var payload struct {
				Upstream  []string `json:"upstream_dns"`
				Bootstrap []string `json:"bootstrap_dns"`
			}
			if json.NewDecoder(r.Body).Decode(&payload) != nil {
				t.Error("invalid test payload")
			}
			results := map[string]string{}
			for _, s := range payload.Upstream {
				if !f.missingTest {
					results[s] = "OK"
				}
				if f.badTest {
					results[s] = "failed with private token=hidden"
				}
			}
			if f.testResults != nil {
				results = f.testResults
			}
			if f.changeDuringTest {
				f.current.Upstream = []string{"9.9.9.9"}
			}
			json.NewEncoder(w).Encode(results)
		case "/dns_config":
			f.writes++
			if f.failAllWrites && f.writes > 1 {
				w.WriteHeader(500)
				return
			}
			var payload map[string]json.RawMessage
			if json.NewDecoder(r.Body).Decode(&payload) != nil {
				t.Error("invalid save payload")
			}
			f.postFields = nil
			for k := range payload {
				f.postFields = append(f.postFields, k)
			}
			raw, _ := json.Marshal(payload)
			var next dnsSettings
			if json.Unmarshal(raw, &next) != nil {
				t.Error("invalid saved settings")
			}
			f.current.dnsSettings = next
			if f.failAllWrites || f.failFirstWrite && f.writes == 1 {
				w.WriteHeader(500)
				return
			}
			w.WriteHeader(200)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	f.manager = dnsManager{endpoint: server.URL, auth: "test-user:test-password", backup: filepath.Join(t.TempDir(), "backups", "dns.json"), client: server.Client()}
	return f
}
func (f *dnsFixture) revision() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return dnsRevision(f.current)
}
func (f *dnsFixture) count(route string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, s := range f.calls {
		if s == route {
			n++
		}
	}
	return n
}

func TestDNSAddressValidation(t *testing.T) {
	for _, address := range []string{"223.5.5.5", "8.8.8.8:5353", "2400:3200::1", "[2400:3200::1]:53", "https://dns.alidns.com/dns-query", "https://doh.pub/dns-query", "tls://dns.alidns.com"} {
		if !validDNSServer(address, false) {
			t.Errorf("rejected valid address %q", address)
		}
	}
	for _, address := range []string{"127.0.0.1:5591", "127.0.0.1:1053", "::1", "[::ffff:127.0.0.1]:53", "0.0.0.0", "224.0.0.1", "http://resolver.example/dns-query", "https://user:secret@resolver.example/dns-query", "file:///tmp/x", "1.1.1.1;id", "1.1.1.1\n8.8.8.8", "https://resolver.example/#fragment", "tls://resolver.example/path", "[/private/]1.1.1.1", "https://.example/dns-query", "1.1.1.1:0", "1.1.1.1:99999"} {
		if validDNSServer(address, false) {
			t.Errorf("accepted unsafe/unsupported address %q", address)
		}
	}
	if validDNSServer("https://dns.alidns.com/dns-query", true) {
		t.Fatal("bootstrap accepted hostname-based resolver")
	}
}
func TestDNSPayloadIsStrictAndBounded(t *testing.T) {
	for _, raw := range []string{`{"revision":"x","config":{},"admin_password":"hidden"}`, `{"config":{"upstream_dns":["1.1.1.1"],"dns_port":53}}`, `{} {}`, strings.Repeat("x", 32769)} {
		var c dnsEdit
		if decodeDNS(strings.NewReader(raw), &c) == nil {
			t.Fatal("accepted invalid/oversized payload")
		}
	}
	c := dnsDefaults()
	c.Upstream = nil
	if validateDNS(c) == nil {
		t.Fatal("accepted empty upstream")
	}
	c = dnsDefaults()
	c.Bootstrap = make([]string, 9)
	if validateDNS(c) == nil {
		t.Fatal("accepted oversized list")
	}
}
func TestDNSSaveTestsEveryServerAndOnlySendsManagedFields(t *testing.T) {
	f := newDNSFixture(t)
	old := f.current.dnsSettings
	candidate := dnsDefaults()
	candidate.Upstream = []string{"https://dns.alidns.com/dns-query"}
	candidate.Bootstrap = []string{"223.5.5.5"}
	candidate.Fallback = []string{"119.29.29.29"}
	if err := f.manager.apply(dnsEdit{candidate, f.revision()}, true); err != nil {
		t.Fatal(err)
	}
	if f.count("/test_upstream_dns") != 1 || f.writes != 1 {
		t.Fatal("test/apply sequence incorrect")
	}
	for _, key := range f.postFields {
		if key != "upstream_dns" && key != "bootstrap_dns" && key != "fallback_dns" && key != "upstream_mode" {
			t.Fatalf("unexpected setting changed: %s", key)
		}
	}
	raw, err := os.ReadFile(f.manager.backup)
	if err != nil {
		t.Fatal(err)
	}
	var saved dnsSnapshot
	if json.Unmarshal(raw, &saved) != nil || !reflect.DeepEqual(saved.Config, old) {
		t.Fatal("backup did not preserve original settings")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(f.manager.backup)
		if info.Mode().Perm() != 0600 {
			t.Fatal("DNS backup not private")
		}
	}
	if !reflect.DeepEqual(f.current.dnsSettings, candidate) {
		t.Fatal("desired DNS config not applied")
	}
}
func TestDNSTestMatchesCoreDefaultPorts(t *testing.T) {
	// AdGuard Home v0.107.79 keys successful results by upstream.Address(),
	// which adds default ports.  Keep these literal API responses independent
	// of the result-matching implementation.
	cases := []struct{ server, key string }{
		{"223.5.5.5", "223.5.5.5:53"},
		{"119.29.29.29:5353", "119.29.29.29:5353"},
		{"2620:fe::10", "[2620:fe::10]:53"},
		{"[2620:fe::10]:5353", "[2620:fe::10]:5353"},
		{"https://dns.alidns.com/dns-query", "https://dns.alidns.com:443/dns-query"},
		{"https://doh.pub:8443/dns-query?name=value", "https://doh.pub:8443/dns-query?name=value"},
		{"https://[2620:fe::10]/dns-query", "https://[2620:fe::10]:443/dns-query"},
		{"tls://dns.example", "tls://dns.example:853"},
		{"tls://[2620:fe::10]", "tls://[2620:fe::10]:853"},
		{"tls://dns.example:8853", "tls://dns.example:8853"},
	}
	for _, tc := range cases {
		t.Run(tc.server, func(t *testing.T) {
			f := newDNSFixture(t)
			f.testResults = map[string]string{tc.key: "OK"}
			c := dnsDefaults()
			c.Upstream = []string{tc.server}
			rows, err := f.manager.test(c)
			if err != nil || len(rows) != 1 || rows[0].Server != tc.server || !rows[0].OK {
				t.Fatalf("core success misreported: rows=%#v err=%v", rows, err)
			}
			if f.writes != 0 {
				t.Fatal("draft test changed DNS settings")
			}
		})
	}
}

func TestDNSTestDoesNotAcceptUnrelatedOrConflictingSuccess(t *testing.T) {
	for _, tc := range []struct {
		server  string
		results map[string]string
	}{
		{"223.5.5.5", map[string]string{}},
		{"223.5.5.5", map[string]string{"223.5.5.5:53": "timeout"}},
		{"223.5.5.5", map[string]string{"223.5.5.5:5353": "OK"}},
		{"223.5.5.5", map[string]string{"119.29.29.29:53": "OK"}},
		{"223.5.5.5", map[string]string{"223.5.5.5": "failed", "223.5.5.5:53": "OK"}},
		{"https://doh.pub/dns-query", map[string]string{"https://doh.pub:8443/dns-query": "OK"}},
		{"https://doh.pub/dns-query", map[string]string{"https://doh.pub:443/other": "OK"}},
		{"https://doh.pub/dns-query?key=a", map[string]string{"https://doh.pub:443/dns-query?key=b": "OK"}},
		{"tls://dns.example", map[string]string{"https://dns.example:853": "OK"}},
	} {
		f := newDNSFixture(t)
		f.testResults = tc.results
		c := dnsDefaults()
		c.Upstream = []string{tc.server}
		rows, err := f.manager.test(c)
		if err != nil || len(rows) != 1 || rows[0].OK {
			t.Fatalf("unconfirmed result accepted: server=%s results=%#v rows=%#v err=%v", tc.server, tc.results, rows, err)
		}
	}
}

func TestDNSSaveAcceptsCoreDefaultPortsAndPreservesInput(t *testing.T) {
	f := newDNSFixture(t)
	f.testResults = map[string]string{
		"223.5.5.5:53": "OK", "119.29.29.29:53": "OK",
		"[2620:fe::10]:53": "OK", "https://doh.pub:443/dns-query": "OK",
	}
	c := dnsDefaults()
	c.Bootstrap = []string{"2620:fe::10"}
	c.Fallback = []string{"https://doh.pub/dns-query"}
	if err := f.manager.apply(dnsEdit{c, f.revision()}, true); err != nil {
		t.Fatal(err)
	}
	if f.writes != 1 || !reflect.DeepEqual(f.current.dnsSettings, c) {
		t.Fatalf("DNS input changed during result matching: %#v", f.current.dnsSettings)
	}
}

func TestDNSTestIncludesFallbackAndBootstrapAndMissingResultsFail(t *testing.T) {
	f := newDNSFixture(t)
	c := dnsDefaults()
	c.Bootstrap = []string{"180.184.1.1"}
	c.Fallback = []string{"114.114.114.114"}
	rows, err := f.manager.test(c)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 {
		t.Fatalf("not all DNS addresses tested: %#v", rows)
	}
	f.missingTest = true
	rows, err = f.manager.test(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.OK {
			t.Fatal("missing test outcome counted as success")
		}
	}
}
func TestDNSTestFailureDoesNotWriteAndDoesNotLeakRawServerErrors(t *testing.T) {
	f := newDNSFixture(t)
	f.badTest = true
	err := f.manager.apply(dnsEdit{dnsDefaults(), f.revision()}, true)
	if err == nil || strings.Contains(err.Error(), "hidden") || f.writes != 0 {
		t.Fatalf("test failure did not protect existing config: %v", err)
	}
	if _, err := os.Stat(f.manager.backup); !os.IsNotExist(err) {
		t.Fatal("failed test changed restore point")
	}
}
func TestDNSStaleRevisionAndConcurrentNativeChangeAreNotOverwritten(t *testing.T) {
	for _, during := range []bool{false, true} {
		f := newDNSFixture(t)
		revision := f.revision()
		if during {
			f.changeDuringTest = true
		} else {
			revision = strings.Repeat("0", 64)
		}
		if f.manager.apply(dnsEdit{dnsDefaults(), revision}, true) == nil || f.writes != 0 {
			t.Fatal("overwrote a concurrent native configuration change")
		}
	}
}
func TestDNSPartialAPIFailureRestoresAndVerifiesOldSettings(t *testing.T) {
	f := newDNSFixture(t)
	f.failFirstWrite = true
	old := f.current.dnsSettings
	candidate := dnsDefaults()
	candidate.Upstream = []string{"1.1.1.1"}
	err := f.manager.apply(dnsEdit{candidate, f.revision()}, true)
	if err == nil || errors.Is(err, errDNSRollback) || f.writes != 2 || !reflect.DeepEqual(f.current.dnsSettings, old) {
		t.Fatalf("old config was not restored: %v", err)
	}
}
func TestDNSUnconfirmedRollbackSignalsFailOpenCleanup(t *testing.T) {
	f := newDNSFixture(t)
	f.failAllWrites = true
	candidate := dnsDefaults()
	candidate.Upstream = []string{"1.1.1.1"}
	if err := f.manager.apply(dnsEdit{candidate, f.revision()}, true); !errors.Is(err, errDNSRollback) {
		t.Fatalf("unconfirmed rollback hidden: %v", err)
	}
	if _, err := os.Stat(f.manager.backup); err != nil {
		t.Fatal("lost recovery snapshot")
	}
}
func TestDNSRestoreCanWorkWithoutExternalConnectivity(t *testing.T) {
	f := newDNSFixture(t)
	f.badTest = true
	previous := dnsDefaults()
	previous.Upstream = []string{"119.29.29.29"}
	if err := f.manager.apply(dnsEdit{previous, f.revision()}, false); err != nil {
		t.Fatal(err)
	}
	if f.count("/test_upstream_dns") != 0 || !reflect.DeepEqual(f.current.dnsSettings, previous) {
		t.Fatal("restore incorrectly required external DNS test")
	}
}
func TestDNSAdvancedConfigsAndInvalidTargetsDoNotWrite(t *testing.T) {
	f := newDNSFixture(t)
	f.current.File = "/private/custom-upstreams.txt"
	if f.manager.apply(dnsEdit{dnsDefaults(), f.revision()}, true) == nil || f.writes != 0 {
		t.Fatal("overwrote external DNS configuration")
	}
	f.current.File = ""
	c := dnsDefaults()
	c.Upstream = []string{"127.0.0.1:5591"}
	if f.manager.apply(dnsEdit{c, f.revision()}, true) == nil || f.writes != 0 {
		t.Fatal("accepted resolver loop")
	}
}
