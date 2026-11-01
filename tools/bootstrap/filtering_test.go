package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const filterStatusFixture = `{"filters":[{"enabled":false,"url":"/local/ads.txt","name":"User \"named\" list"}],"whitelist_filters":[{"enabled":true,"url":"https://allow.example/list.txt","name":"Allow list"}]}`

func TestFilteringSetBodyPreservesCurrentState(t *testing.T) {
	var out bytes.Buffer
	err := writeFilteringSetBody([]string{"/local/ads.txt", "block", "refresh"}, strings.NewReader(filterStatusFixture), &out)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		URL       string `json:"url"`
		Whitelist bool   `json:"whitelist"`
		Data      struct {
			Name    string `json:"name"`
			URL     string `json:"url"`
			Enabled bool   `json:"enabled"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.URL != "/local/ads.txt" || got.Data.URL != got.URL || got.Data.Name != `User "named" list` || got.Data.Enabled || got.Whitelist {
		t.Fatalf("set body did not preserve current filter state: %+v", got)
	}
}

func TestFilteringSetBodyChangesOneField(t *testing.T) {
	var out bytes.Buffer
	err := writeFilteringSetBody([]string{"https://allow.example/list.txt", "allow", "enabled", "false"}, strings.NewReader(filterStatusFixture), &out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"whitelist":true`)) || !bytes.Contains(out.Bytes(), []byte(`"enabled":false`)) || !bytes.Contains(out.Bytes(), []byte(`"name":"Allow list"`)) {
		t.Fatalf("allow-list set body lost its type or name: %s", out.String())
	}
}

func TestFilteringCopyBodyPreservesNameAndDisabledState(t *testing.T) {
	var out bytes.Buffer
	err := writeFilteringCopyBody([]string{"/local/ads.txt", "/local/new.txt", "block"}, strings.NewReader(filterStatusFixture), &out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"name":"User \"named\" list"`)) || !bytes.Contains(out.Bytes(), []byte(`"enabled":false`)) || !bytes.Contains(out.Bytes(), []byte(`"url":"/local/new.txt"`)) {
		t.Fatalf("copy body did not preserve source metadata: %s", out.String())
	}
}

func TestFilteringStatusRejectsUnknownAndMalformedState(t *testing.T) {
	_, err := readFilteringStatus(strings.NewReader(`{"something":[]}`), "block")
	if err == nil {
		t.Fatal("missing filters array was accepted")
	}
	_, err = readFilteringStatus(strings.NewReader(`{"filters":[`), "block")
	if err == nil {
		t.Fatal("malformed filter status was accepted")
	}
	_, err = readFilteringStatus(strings.NewReader(`{"filters":[],"whitelist_filters":[]}`), "block")
	if err != nil {
		t.Fatalf("valid empty arrays were rejected: %v", err)
	}
	_, err = readFilteringStatus(strings.NewReader(`{"filters":[{"url":"/x","name":"x"}],"whitelist_filters":[]}`), "block")
	if err == nil {
		t.Fatal("filter with missing enabled state was accepted as disabled")
	}
	_, err = readFilteringStatus(strings.NewReader(`{"filters":[],"whitelist_filters":null}`), "block")
	if err == nil {
		t.Fatal("null allow-list state was treated as an empty list")
	}
	entries, err := readFilteringStatus(strings.NewReader(filterStatusFixture), "block")
	if err != nil {
		t.Fatal(err)
	}
	_, err = findFilteringEntry(entries, "https://missing.example/list.txt")
	if !errors.Is(err, errFilterNotFound) {
		t.Fatalf("missing filter error = %v", err)
	}
}

func TestFilteringEnabledCountUsesBothAdGuardLists(t *testing.T) {
	count, err := countEnabledFilteringEntries(strings.NewReader(filterStatusFixture))
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("enabled filter count = %d, want 1", count)
	}
	count, err = countEnabledFilteringEntries(strings.NewReader(`{"filters":[],"whitelist_filters":[]}`))
	if err != nil || count != 0 {
		t.Fatalf("empty lists count = %d, err = %v", count, err)
	}
}

func TestFilteringIsEnabledReadsTheBooleanField(t *testing.T) {
	for _, want := range []string{"false", "true"} {
		t.Run(want, func(t *testing.T) {
			status := strings.Replace(filterStatusFixture, `"enabled":false`, `"enabled":`+want, 1)
			var out bytes.Buffer
			if err := writeFilteringEnabled([]string{"/local/ads.txt", "block"}, strings.NewReader(status), &out); err != nil {
				t.Fatal(err)
			}
			if out.String() != want {
				t.Fatalf("enabled = %q, want %q", out.String(), want)
			}
		})
	}
	err := writeFilteringEnabled([]string{"/missing.txt", "block"}, strings.NewReader(filterStatusFixture), &bytes.Buffer{})
	if !errors.Is(err, errFilterNotFound) {
		t.Fatalf("missing filter error = %v", err)
	}
}

func TestFilteringNewAndRemoveBodiesUseJSONEncoding(t *testing.T) {
	var add bytes.Buffer
	if err := writeFilteringNewBody([]string{`quote " and slash \\`, `https://rules.example/list?token=a&b=c`, "allow"}, &add); err != nil {
		t.Fatal(err)
	}
	var gotAdd struct {
		Name      string `json:"name"`
		URL       string `json:"url"`
		Whitelist bool   `json:"whitelist"`
	}
	if err := json.Unmarshal(add.Bytes(), &gotAdd); err != nil {
		t.Fatal(err)
	}
	if gotAdd.Name != `quote " and slash \\` || gotAdd.URL != `https://rules.example/list?token=a&b=c` || !gotAdd.Whitelist {
		t.Fatalf("new filter body was not encoded safely: %+v", gotAdd)
	}
	var remove bytes.Buffer
	if err := writeFilteringRemoveBody([]string{`/data/filters/a"b.txt`, "block"}, &remove); err != nil {
		t.Fatal(err)
	}
	var gotRemove struct {
		URL       string `json:"url"`
		Whitelist bool   `json:"whitelist"`
	}
	if err := json.Unmarshal(remove.Bytes(), &gotRemove); err != nil {
		t.Fatal(err)
	}
	if gotRemove.URL != `/data/filters/a"b.txt` || gotRemove.Whitelist {
		t.Fatalf("remove body did not preserve list type and URL: %+v", gotRemove)
	}
}
