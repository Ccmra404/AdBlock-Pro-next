//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestMigrateStatePreservesNestedDataInodeAndLegacyPath(t *testing.T) {
	legacy, current := stateTestPaths(t)
	personal := filepath.Join(legacy, "subscriptions", "personal")
	if err := os.MkdirAll(personal, 0700); err != nil {
		t.Fatal(err)
	}
	dataFile := filepath.Join(personal, "rules.txt")
	if err := os.WriteFile(dataFile, []byte("user rule\n"), 0600); err != nil {
		t.Fatal(err)
	}
	openFile, err := os.OpenFile(dataFile, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer openFile.Close()
	before, err := os.Stat(legacy)
	if err != nil {
		t.Fatal(err)
	}

	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	if _, err := openFile.WriteString("after migration\n"); err != nil {
		t.Fatal(err)
	}
	legacyInfo, err := os.Lstat(legacy)
	if err != nil || legacyInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("legacy path is not a symlink: %v", err)
	}
	target, err := os.Readlink(legacy)
	if err != nil || target != current {
		t.Fatalf("legacy path target = %q, err = %v", target, err)
	}
	after, err := os.Stat(current)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("current path does not retain the original directory inode: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(legacy, "subscriptions", "personal", "rules.txt"))
	if err != nil || string(got) != "user rule\nafter migration\n" {
		t.Fatalf("legacy path did not reach nested data: %q, err = %v", got, err)
	}
	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatalf("second migration should be idempotent: %v", err)
	}
}

func TestMigrateStateRejectsTwoRealDirectoriesWithoutChangingData(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(current, 0700); err != nil {
		t.Fatal(err)
	}
	legacyFile := filepath.Join(legacy, "legacy.txt")
	currentFile := filepath.Join(current, "current.txt")
	if err := os.WriteFile(legacyFile, []byte("legacy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentFile, []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateState(legacy, current, exchangeStateDirectories); err == nil {
		t.Fatal("two real directories must be rejected")
	}
	if info, err := os.Lstat(legacy); err != nil || !info.IsDir() {
		t.Fatalf("legacy directory changed: %v", err)
	}
	for path, want := range map[string]string{legacyFile: "legacy", currentFile: "current"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s changed: %q, err = %v", path, got, err)
		}
	}
}

func TestMigrateStateResumesExactSelfLinkAfterInterruption(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "keep"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(current, current); err != nil {
		t.Fatal(err)
	}
	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatalf("interrupted exact self-link should be recoverable: %v", err)
	}
	if !isExactLink(legacy, current) {
		t.Fatal("legacy path was not linked to current state")
	}
	if got, err := os.ReadFile(filepath.Join(current, "keep")); err != nil || string(got) != "data" {
		t.Fatalf("legacy data not present after recovery: %q, err = %v", got, err)
	}
}

func TestMigrateStateExchangeFailureRemovesOnlyNewTemporaryLink(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "keep"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected exchange failure")
	err := migrateState(legacy, current, func(string, string) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("expected injected failure, got %v", err)
	}
	if info, err := os.Lstat(legacy); err != nil || !info.IsDir() {
		t.Fatalf("original legacy directory was not preserved: %v", err)
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("new temporary link was not cleaned up: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(legacy, "keep")); err != nil || string(got) != "data" {
		t.Fatalf("legacy data changed: %q, err = %v", got, err)
	}
}

func TestMigrateStateRejectsAnotherOpenDescriptionHoldingLayoutLock(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "keep"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(legacy, ".state-layout.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	if err := migrateState(legacy, current, exchangeStateDirectories); err == nil {
		t.Fatal("migration should reject an already-held layout lock")
	}
	if info, err := os.Lstat(legacy); err != nil || !info.IsDir() {
		t.Fatalf("legacy directory changed while lock was held: %v", err)
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("current path changed while lock was held: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(legacy, "keep")); err != nil || string(got) != "data" {
		t.Fatalf("legacy data changed while lock was held: %q, err = %v", got, err)
	}
}

func TestMigrateStateRestoresMissingLegacyLinkForExistingState(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(current, 0700); err != nil {
		t.Fatal(err)
	}
	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	if !isExactLink(legacy, current) {
		t.Fatal("missing legacy path was not restored as a symlink")
	}
}

func TestPrepareDowngradeRestoresLegacyLayoutAndIsIdempotent(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.MkdirAll(filepath.Join(legacy, "lists"), 0700); err != nil {
		t.Fatal(err)
	}
	dataFile := filepath.Join(legacy, "lists", "personal.txt")
	if err := os.WriteFile(dataFile, []byte("personal data"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	if err := prepareDowngrade(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	legacyInfo, err := os.Lstat(legacy)
	if err != nil || !legacyInfo.IsDir() {
		t.Fatalf("legacy path was not restored as a real directory: %v", err)
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("current path should be removed after downgrade preparation: %v", err)
	}
	after, err := os.Stat(legacy)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("legacy path does not retain the original directory inode: %v", err)
	}
	if got, err := os.ReadFile(dataFile); err != nil || string(got) != "personal data" {
		t.Fatalf("personal data changed: %q, err = %v", got, err)
	}
	if err := prepareDowngrade(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatalf("repeated downgrade preparation should be idempotent: %v", err)
	}
	// The old module's uninstaller removes the runtime root recursively.
	if err := os.RemoveAll(filepath.Dir(current)); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(dataFile); err != nil || string(got) != "personal data" {
		t.Fatalf("old-version runtime cleanup removed prepared legacy data: %q, err = %v", got, err)
	}
}

func TestPrepareDowngradeCleansExactSelfLinkResidual(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "keep"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(current, current); err != nil {
		t.Fatal(err)
	}
	if err := prepareDowngrade(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("exact self-link was not removed: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(legacy, "keep")); err != nil || string(got) != "data" {
		t.Fatalf("legacy data changed: %q, err = %v", got, err)
	}
}

func TestPrepareDowngradeExchangeFailurePreservesMigratedData(t *testing.T) {
	legacy, current := stateTestPaths(t)
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "keep"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrateState(legacy, current, exchangeStateDirectories); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected exchange failure")
	err := prepareDowngrade(legacy, current, func(string, string) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("expected injected failure, got %v", err)
	}
	if !isExactLink(legacy, current) {
		t.Fatal("failed downgrade changed the legacy path")
	}
	currentInfo, err := os.Lstat(current)
	if err != nil || !currentInfo.IsDir() {
		t.Fatalf("failed downgrade changed the current directory: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(legacy, "keep")); err != nil || string(got) != "data" {
		t.Fatalf("personal data is unavailable through legacy path: %q, err = %v", got, err)
	}
}

func stateTestPaths(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	legacy := filepath.Join(root, "adb", "bindhosts_personal")
	current := filepath.Join(root, "adb", "adblockpro", "state")
	if err := os.MkdirAll(filepath.Dir(legacy), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(current), 0700); err != nil {
		t.Fatal(err)
	}
	return legacy, current
}
