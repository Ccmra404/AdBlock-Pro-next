package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var errFilterNotFound = errors.New("filter was not found")

type filteringEntry struct {
	Enabled *bool  `json:"enabled"`
	URL     string `json:"url"`
	Name    string `json:"name"`
}

type filteringStatus struct {
	Filters          json.RawMessage `json:"filters"`
	WhitelistFilters json.RawMessage `json:"whitelist_filters"`
}

func readFilteringStatus(r io.Reader, list string) ([]filteringEntry, error) {
	data, err := io.ReadAll(io.LimitReader(r, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("read filter status: %w", err)
	}
	var status filteringStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return nil, fmt.Errorf("invalid AdGuard Home filter status: %w", err)
	}
	if len(status.Filters) == 0 || len(status.WhitelistFilters) == 0 {
		return nil, errors.New("AdGuard Home filter status is missing a filter array")
	}
	// AdGuard Home encodes an empty subscription list as null in live status.
	if bytes.Equal(bytes.TrimSpace(status.Filters), []byte("null")) {
		status.Filters = json.RawMessage("[]")
	}
	if bytes.Equal(bytes.TrimSpace(status.WhitelistFilters), []byte("null")) {
		status.WhitelistFilters = json.RawMessage("[]")
	}
	raw := status.Filters
	if list == "allow" {
		raw = status.WhitelistFilters
	} else if list != "block" {
		return nil, errors.New("filter list must be block or allow")
	}
	var entries []filteringEntry
	if err := json.Unmarshal(raw, &entries); err != nil || entries == nil {
		if err == nil {
			err = errors.New("filters must be an array")
		}
		return nil, fmt.Errorf("invalid AdGuard Home filters: %w", err)
	}
	for _, entry := range entries {
		if entry.URL == "" || entry.Name == "" || entry.Enabled == nil {
			return nil, errors.New("AdGuard Home filter is missing its URL, name, or enabled state")
		}
	}
	return entries, nil
}

func findFilteringEntry(entries []filteringEntry, url string) (filteringEntry, error) {
	var found *filteringEntry
	for i := range entries {
		if entries[i].URL != url {
			continue
		}
		if found != nil {
			return filteringEntry{}, errors.New("AdGuard Home returned duplicate filters for the same URL")
		}
		found = &entries[i]
	}
	if found == nil {
		return filteringEntry{}, errFilterNotFound
	}
	return *found, nil
}

func countEnabledFilteringEntries(r io.Reader) (int, error) {
	data, err := io.ReadAll(io.LimitReader(r, 8<<20))
	if err != nil {
		return 0, err
	}
	filters, err := readFilteringStatus(bytes.NewReader(data), "block")
	if err != nil {
		return 0, err
	}
	allow, err := readFilteringStatus(bytes.NewReader(data), "allow")
	if err != nil {
		return 0, err
	}
	return countEnabled(filters) + countEnabled(allow), nil
}

func writeFilteringEnabled(args []string, r io.Reader, w io.Writer) error {
	if len(args) != 2 {
		return errors.New("usage: filtering-is-enabled URL block|allow")
	}
	entries, err := readFilteringStatus(r, args[1])
	if err != nil {
		return err
	}
	entry, err := findFilteringEntry(entries, args[0])
	if err != nil {
		return err
	}
	_, err = fmt.Fprint(w, *entry.Enabled)
	return err
}

func countEnabled(entries []filteringEntry) int {
	count := 0
	for _, entry := range entries {
		if entry.Enabled != nil && *entry.Enabled {
			count++
		}
	}
	return count
}

func writeFilteringSetBody(args []string, r io.Reader, w io.Writer) error {
	if len(args) < 3 || len(args) > 4 {
		return errors.New("usage: filtering-set-body URL block|allow refresh|enabled|name|url [VALUE]")
	}
	url, list, field := args[0], args[1], args[2]
	value := ""
	if len(args) == 4 {
		value = args[3]
	}
	entries, err := readFilteringStatus(r, list)
	if err != nil {
		return err
	}
	entry, err := findFilteringEntry(entries, url)
	if err != nil {
		return err
	}
	name, targetURL, enabled := entry.Name, entry.URL, *entry.Enabled
	switch field {
	case "refresh":
		if value != "" {
			return errors.New("refresh does not accept a value")
		}
	case "enabled":
		if value != "true" && value != "false" {
			return errors.New("enabled value must be true or false")
		}
		enabled = value == "true"
	case "name":
		if value == "" {
			return errors.New("filter name cannot be empty")
		}
		name = value
	case "url":
		if value == "" {
			return errors.New("filter URL cannot be empty")
		}
		targetURL = value
	default:
		return errors.New("filter update must be refresh, enabled, name, or url")
	}
	body := map[string]any{
		"url":       entry.URL,
		"whitelist": list == "allow",
		"data": map[string]any{
			"name":    name,
			"url":     targetURL,
			"enabled": enabled,
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = w.Write(encoded)
	return err
}

func writeFilteringCopyBody(args []string, r io.Reader, w io.Writer) error {
	if len(args) != 3 || args[2] != "block" && args[2] != "allow" {
		return errors.New("usage: filtering-copy-body SOURCE_URL TARGET_URL block|allow")
	}
	entries, err := readFilteringStatus(r, args[2])
	if err != nil {
		return err
	}
	entry, err := findFilteringEntry(entries, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{
		"url":       args[1],
		"whitelist": args[2] == "allow",
		"data": map[string]any{
			"name":    entry.Name,
			"url":     args[1],
			"enabled": *entry.Enabled,
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = w.Write(encoded)
	return err
}

func writeFilteringAddBody(args []string, r io.Reader, w io.Writer) error {
	if len(args) != 3 || args[2] != "block" && args[2] != "allow" {
		return errors.New("usage: filtering-add-body SOURCE_URL TARGET_URL block|allow")
	}
	entries, err := readFilteringStatus(r, args[2])
	if err != nil {
		return err
	}
	entry, err := findFilteringEntry(entries, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{
		"name":      entry.Name,
		"url":       args[1],
		"whitelist": args[2] == "allow",
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = w.Write(encoded)
	return err
}

func writeFilteringNewBody(args []string, w io.Writer) error {
	if len(args) != 3 || args[2] != "block" && args[2] != "allow" || args[0] == "" || args[1] == "" {
		return errors.New("usage: filtering-new-body NAME URL block|allow")
	}
	body := map[string]any{
		"name":      args[0],
		"url":       args[1],
		"whitelist": args[2] == "allow",
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = w.Write(encoded)
	return err
}

func writeFilteringRemoveBody(args []string, w io.Writer) error {
	if len(args) != 2 || args[0] == "" || args[1] != "block" && args[1] != "allow" {
		return errors.New("usage: filtering-remove-body URL block|allow")
	}
	body := map[string]any{"url": args[0], "whitelist": args[1] == "allow"}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = w.Write(encoded)
	return err
}
