package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func fixture(t *testing.T) (service, config) {
	t.Helper()
	s := service{dir: t.TempDir()}
	c := config{defaultEndpoint, defaultModel, "fixture-only-key"}
	b, _ := json.Marshal(c)
	if e := s.configure(bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	return s, c
}
func prepare(t *testing.T, s service, c config, id string, domains []string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"domains": domains, "endpoint": c.Endpoint, "model": c.Model})
	if e := s.prepare(id, bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
}
func response(items []item, finish string) string {
	b, _ := json.Marshal(map[string]any{"results": items})
	out, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": finish, "message": map[string]any{"role": "assistant", "content": string(b)}}}})
	return string(out)
}
func TestConfigurationAndPrivacy(t *testing.T) {
	s, c := fixture(t)
	var out bytes.Buffer
	if e := s.run([]string{"status"}, nil, &out); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(out.String(), c.Key) || !strings.Contains(out.String(), `"configured":true`) {
		t.Fatal(out.String())
	}
	c.Key = ""
	b, _ := json.Marshal(c)
	if e := s.configure(bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	c.Endpoint = "https://gateway.example/v1/chat/completions"
	b, _ = json.Marshal(c)
	if e := s.configure(bytes.NewReader(b)); e == nil {
		t.Fatal("reused key across endpoints")
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(filepath.Join(s.dir, "config.json"))
		if st.Mode().Perm() != 0600 {
			t.Fatal(st.Mode())
		}
	}
	if e := s.run([]string{"clear"}, nil, &out); e != nil {
		t.Fatal(e)
	}
	if _, e := s.config(); e == nil {
		t.Fatal("key retained")
	}
}
func TestRejectInvalidInputAndChangedConsent(t *testing.T) {
	s, c := fixture(t)
	for _, url := range []string{"http://api.example/chat/completions", "https://127.0.0.1/chat/completions", "https://x.local/chat/completions", "https://u:p@api.example/chat/completions", "https://api.example/chat/completions?key=x", "https://api.example/nope"} {
		bad := c
		bad.Endpoint = url
		if validateConfig(bad) == nil {
			t.Fatal(url)
		}
	}
	for _, domains := range [][]string{nil, {"a.example", "a.example"}, {"https://a.example"}, {"127.0.0.1"}, {"a.example;sh"}, make([]string, 51)} {
		b, _ := json.Marshal(map[string]any{"domains": domains, "endpoint": c.Endpoint, "model": c.Model})
		if s.prepare("1", bytes.NewReader(b)) == nil {
			t.Fatal(domains)
		}
	}
	if s.prepare("../escape", strings.NewReader(`{"domains":["a.example"],"endpoint":"`+c.Endpoint+`","model":"`+c.Model+`"}`)) == nil {
		t.Fatal("path traversal")
	}
	if s.prepare("2", strings.NewReader(`{"domains":["a.example"],"endpoint":"https://other.example/chat/completions","model":"x"}`)) == nil {
		t.Fatal("changed target accepted")
	}
	for _, raw := range []string{`{} {}`, `{"secret":"bad"}`, strings.Repeat("x", 17000)} {
		if s.configure(strings.NewReader(raw)) == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}
func TestModelOutputCannotInventRules(t *testing.T) {
	domains := []string{"a.example", "b.example"}
	good := []item{{"b.example", "essential", "必要服务"}, {"a.example", "ad", "疑似广告"}}
	got, e := parseResponse([]byte(response(good, "stop")), domains)
	if e != nil || got[0].Domain != "a.example" {
		t.Fatal(got, e)
	}
	cases := [][]item{{good[0]}, {good[0], good[0]}, {{"evil.example", "ad", "x"}, good[0]}, {{"a.example", "execute", "sh"}, good[0]}, {{"a.example", "ad", strings.Repeat("文", 241)}, good[0]}}
	for _, items := range cases {
		if _, e := parseResponse([]byte(response(items, "stop")), domains); e == nil {
			t.Fatal(items)
		}
	}
	if _, e := parseResponse([]byte(response(good, "length")), domains); e == nil {
		t.Fatal("truncated result accepted")
	}
}
func TestSDKRequestAndWorkerLifecycle(t *testing.T) {
	s, c := fixture(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+c.Key {
			t.Error("incorrect SDK request")
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
			Stream bool `json:"stream"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Model != c.Model || body.Stream || len(body.Messages) != 2 || body.Messages[1].Content != "ads.example" {
			t.Error("payload contains unexpected data")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response([]item{{"ads.example", "unknown", "证据不足"}}, "stop"))
	}))
	defer server.Close()
	// Only the injected transport routes a validated public target to the test server.
	c.Endpoint = "https://gateway.example/v1/chat/completions"
	if e := save(filepath.Join(s.dir, "config.json"), c); e != nil {
		t.Fatal(e)
	}
	s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		u := *r.URL
		clone.URL = &u
		clone.URL.Scheme = "http"
		clone.URL.Host = strings.TrimPrefix(server.URL, "http://")
		return server.Client().Transport.RoundTrip(clone)
	})}
	prepare(t, s, c, "123", []string{"ads.example"})
	if e := s.worker("123"); e != nil {
		t.Fatal(e)
	}
	j, e := s.poll("123")
	if e != nil || j.Status != "success" || len(j.Results) != 1 || calls != 1 {
		t.Fatal(j, e, calls)
	}
	if e := s.worker("123"); e != nil || calls != 1 {
		t.Fatal("completed job repeated", e, calls)
	}
	prepare(t, s, c, "124", []string{"ads.example"})
	c.Endpoint = "https://changed.example/chat/completions"
	save(filepath.Join(s.dir, "config.json"), c)
	if e := s.worker("124"); e != nil {
		t.Fatal(e)
	}
	j, e = s.poll("124")
	if e != nil || j.Status != "failed" || calls != 1 {
		t.Fatal(j, e, calls)
	}
}
func TestProviderErrorsAreSanitized(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, c := fixture(t)
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				fmt.Fprint(w, `{"error":{"message":"fixture-secret-provider-message","type":"bad"}}`)
			}))
			defer server.Close()
			c.Endpoint = server.URL + "/v1/chat/completions"
			s.client = server.Client()
			_, e := s.classify(c, []string{"a.example"})
			if e == nil || strings.Contains(e.Error(), "fixture-secret") || calls != 1 {
				t.Fatal(e, calls)
			}
		})
	}
}
func TestStaleAndInterruptedJobs(t *testing.T) {
	s, c := fixture(t)
	prepare(t, s, c, "1", []string{"a.example"})
	j, _ := s.poll("1")
	j.Updated = time.Now().Unix() - 101
	save(filepath.Join(s.dir, "jobs/1/result.json"), j)
	j, e := s.poll("1")
	if e != nil || j.Status != "failed" {
		t.Fatal(j, e)
	}
	j.Updated = time.Now().Unix() - 601
	save(filepath.Join(s.dir, "jobs/1/result.json"), j)
	if _, e := s.poll("1"); e == nil {
		t.Fatal("expired domains retained")
	}
}
func TestDestinationAndBoundedResponse(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "fe80::1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Fatal(ip)
		}
	}
	if !publicIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("public address rejected")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "300000")
		fmt.Fprint(w, strings.Repeat("x", 300000))
	}))
	defer server.Close()
	client := server.Client()
	client.Transport = boundedTransport{client.Transport}
	r, e := client.Get(server.URL)
	if r != nil {
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}
	if e == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestSpecialUseAPIDestinations(t *testing.T) {
	for _, value := range []string{
		"100.64.0.1", "100.100.100.200", "100.127.255.254", "198.18.0.1", "198.19.255.254",
		"192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "fec0::1", "2001:db8::1",
		"2001:2::1", "64:ff9b:1::1", "::ffff:100.100.100.200", "64:ff9b::6464:64c8", "64:ff9b::a00:1",
	} {
		if publicIP(net.ParseIP(value)) {
			t.Errorf("special-use API destination accepted: %s", value)
		}
	}
	for _, value := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"} {
		if !publicIP(net.ParseIP(value)) {
			t.Errorf("public API destination rejected: %s", value)
		}
	}
}
