package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	legacyStatePath  = "/data/adb/bindhosts_personal"
	currentStatePath = "/data/adb/adblockpro/state"
)

func migrateProductionState() error {
	return migrateState(legacyStatePath, currentStatePath, exchangeStateDirectories)
}

func prepareProductionDowngrade() error {
	return prepareDowngrade(legacyStatePath, currentStatePath, exchangeStateDirectories)
}

// migrateState moves the directory entry atomically while retaining the old
// absolute path as a symlink. The exchange hook keeps syscall failures
// deterministic in tests.
func migrateState(legacyPath, currentPath string, exchange func(string, string) error) error {
	legacyPath, currentPath, err := normalizeStatePaths(legacyPath, currentPath)
	if err != nil {
		return err
	}
	lockPath, err := stateLayoutLockPath(legacyPath, currentPath)
	if err != nil {
		return err
	}
	return withStateMigrationLock(lockPath, func() error {
		return migrateStateLocked(legacyPath, currentPath, exchange)
	})
}

func prepareDowngrade(legacyPath, currentPath string, exchange func(string, string) error) error {
	legacyPath, currentPath, err := normalizeStatePaths(legacyPath, currentPath)
	if err != nil {
		return err
	}
	lockPath, err := stateLayoutLockPath(legacyPath, currentPath)
	if err != nil {
		return err
	}
	return withStateMigrationLock(lockPath, func() error {
		return prepareDowngradeLocked(legacyPath, currentPath, exchange)
	})
}

// stateLayoutLockPath validates enough of the layout to select the lock
// inside the existing state inode. The operation re-reads both paths after
// acquiring this lock before making any change.
func stateLayoutLockPath(legacyPath, currentPath string) (string, error) {
	legacy, legacyErr := os.Lstat(legacyPath)
	if legacyErr != nil && !os.IsNotExist(legacyErr) {
		return "", fmt.Errorf("inspect legacy path before locking: %w", legacyErr)
	}
	current, currentErr := os.Lstat(currentPath)
	if currentErr != nil && !os.IsNotExist(currentErr) {
		return "", fmt.Errorf("inspect current path before locking: %w", currentErr)
	}
	legacyExists, currentExists := legacyErr == nil, currentErr == nil
	legacyDir := legacyExists && legacy.Mode().IsDir()
	currentDir := currentExists && current.Mode().IsDir()
	legacyLink := legacyExists && legacy.Mode()&os.ModeSymlink != 0
	currentSelfLink := currentExists && current.Mode()&os.ModeSymlink != 0 && isExactLink(currentPath, currentPath)

	if legacyDir && (!currentExists || currentSelfLink) {
		return filepath.Join(legacyPath, ".state-layout.lock"), nil
	}
	if legacyLink && currentDir && isExactLink(legacyPath, currentPath) {
		return filepath.Join(legacyPath, ".state-layout.lock"), nil
	}
	if !legacyExists && currentDir {
		return filepath.Join(currentPath, ".state-layout.lock"), nil
	}
	return "", errors.New("state paths are ambiguous; refusing to lock or change either path")
}

func normalizeStatePaths(legacyPath, currentPath string) (string, string, error) {
	legacyPath, err := filepath.Abs(filepath.Clean(legacyPath))
	if err != nil {
		return "", "", fmt.Errorf("resolve legacy path: %w", err)
	}
	currentPath, err = filepath.Abs(filepath.Clean(currentPath))
	if err != nil {
		return "", "", fmt.Errorf("resolve current path: %w", err)
	}
	if legacyPath == currentPath {
		return "", "", errors.New("legacy and current paths must differ")
	}
	return legacyPath, currentPath, nil
}

func migrateStateLocked(legacyPath, currentPath string, exchange func(string, string) error) error {
	legacy, legacyErr := os.Lstat(legacyPath)
	if legacyErr != nil && !os.IsNotExist(legacyErr) {
		return fmt.Errorf("inspect legacy path: %w", legacyErr)
	}
	current, currentErr := os.Lstat(currentPath)
	if currentErr != nil && !os.IsNotExist(currentErr) {
		return fmt.Errorf("inspect current path: %w", currentErr)
	}
	legacyExists := legacyErr == nil
	currentExists := currentErr == nil
	legacyDir := legacyExists && legacy.Mode().IsDir()
	currentDir := currentExists && current.Mode().IsDir()
	legacyLink := legacyExists && legacy.Mode()&os.ModeSymlink != 0
	currentLink := currentExists && current.Mode()&os.ModeSymlink != 0

	if legacyLink && currentDir && isExactLink(legacyPath, currentPath) {
		return nil
	}
	if !legacyExists && currentDir {
		if err := os.Symlink(currentPath, legacyPath); err != nil {
			return fmt.Errorf("restore legacy path link: %w", err)
		}
		if err := syncStateDirectory(filepath.Dir(legacyPath)); err != nil {
			return fmt.Errorf("legacy link was created but its parent directory sync failed: %w", err)
		}
		return nil
	}
	if legacyDir && !currentExists {
		if err := os.Symlink(currentPath, currentPath); err != nil {
			return fmt.Errorf("create temporary current path link: %w", err)
		}
		if err := syncStateDirectory(filepath.Dir(currentPath)); err != nil {
			return fmt.Errorf("temporary self-link was created; exchange was not attempted because parent directory sync failed: %w", err)
		}
		if err := exchange(legacyPath, currentPath); err != nil {
			cleanupErr := removeExactSelfLink(currentPath, currentPath)
			if cleanupErr == nil {
				cleanupErr = syncStateDirectory(filepath.Dir(currentPath))
			}
			if cleanupErr != nil {
				return fmt.Errorf("directory exchange failed; original legacy directory remains; temporary self-link cleanup or sync failed: %w (exchange error: %v)", cleanupErr, err)
			}
			return fmt.Errorf("directory exchange failed before completion; original legacy directory remains: %w", err)
		}
		if err := syncStateParentDirectories(legacyPath, currentPath); err != nil {
			return fmt.Errorf("directory exchange completed, but parent directory sync failed: %w", err)
		}
		return nil
	}
	if legacyDir && currentLink && isExactLink(currentPath, currentPath) {
		if err := syncStateDirectory(filepath.Dir(currentPath)); err != nil {
			return fmt.Errorf("temporary self-link exists; exchange was not attempted because parent directory sync failed: %w", err)
		}
		if err := exchange(legacyPath, currentPath); err != nil {
			return fmt.Errorf("resume state directory exchange: %w", err)
		}
		if err := syncStateParentDirectories(legacyPath, currentPath); err != nil {
			return fmt.Errorf("resumed directory exchange completed, but parent directory sync failed: %w", err)
		}
		return nil
	}
	if !legacyExists && !currentExists {
		return errors.New("no legacy state or current state directory exists")
	}
	return errors.New("state paths are ambiguous; refusing to change either path")
}

func prepareDowngradeLocked(legacyPath, currentPath string, exchange func(string, string) error) error {
	legacy, legacyErr := os.Lstat(legacyPath)
	if legacyErr != nil && !os.IsNotExist(legacyErr) {
		return fmt.Errorf("inspect legacy path: %w", legacyErr)
	}
	current, currentErr := os.Lstat(currentPath)
	if currentErr != nil && !os.IsNotExist(currentErr) {
		return fmt.Errorf("inspect current path: %w", currentErr)
	}
	legacyExists := legacyErr == nil
	currentExists := currentErr == nil
	legacyDir := legacyExists && legacy.Mode().IsDir()
	legacyLink := legacyExists && legacy.Mode()&os.ModeSymlink != 0

	if legacyDir && !currentExists {
		return nil
	}
	if legacyDir && currentExists && isExactLink(currentPath, currentPath) {
		if err := syncStateParentDirectories(legacyPath, currentPath); err != nil {
			return fmt.Errorf("legacy layout is restored, but parent directory sync failed; self-link retained: %w", err)
		}
		if err := removeExactSelfLink(currentPath, currentPath); err != nil {
			return fmt.Errorf("legacy layout is restored, but self-link cleanup failed: %w", err)
		}
		if err := syncStateDirectory(filepath.Dir(currentPath)); err != nil {
			return fmt.Errorf("self-link was removed, but its parent directory sync failed: %w", err)
		}
		return nil
	}
	if legacyLink && currentExists && current.Mode().IsDir() && isExactLink(legacyPath, currentPath) {
		if err := exchange(legacyPath, currentPath); err != nil {
			return fmt.Errorf("exchange state directories for downgrade: %w", err)
		}
		// Inspect the resulting layout before unlinking. If a later operation
		// fails, this leaves a recoverable L=directory, N=self-link state.
		legacyAfter, legacyAfterErr := os.Lstat(legacyPath)
		if legacyAfterErr != nil {
			return fmt.Errorf("verify legacy directory after exchange: %w", legacyAfterErr)
		}
		if !legacyAfter.IsDir() {
			return errors.New("legacy path is not a real directory after exchange; refusing cleanup")
		}
		if !isExactLink(currentPath, currentPath) {
			return errors.New("current path is not the expected self-link after exchange; refusing cleanup")
		}
		if err := syncStateParentDirectories(legacyPath, currentPath); err != nil {
			return fmt.Errorf("directory exchange completed, but parent directory sync failed; self-link retained for retry: %w", err)
		}
		if err := removeExactSelfLink(currentPath, currentPath); err != nil {
			return fmt.Errorf("directory exchange completed, but self-link cleanup failed: %w", err)
		}
		if err := syncStateDirectory(filepath.Dir(currentPath)); err != nil {
			return fmt.Errorf("directory exchange completed and self-link was removed, but parent directory sync failed: %w", err)
		}
		return nil
	}
	return errors.New("state paths are ambiguous; refusing to change either path")
}

func syncStateParentDirectories(firstPath, secondPath string) error {
	if err := syncStateDirectory(filepath.Dir(firstPath)); err != nil {
		return fmt.Errorf("sync first parent directory: %w", err)
	}
	if err := syncStateDirectory(filepath.Dir(secondPath)); err != nil {
		return fmt.Errorf("sync second parent directory: %w", err)
	}
	return nil
}

func isExactLink(linkPath, targetPath string) bool {
	target, err := os.Readlink(linkPath)
	return err == nil && target == targetPath
}

func removeExactSelfLink(path, target string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 || !isExactLink(path, target) {
		return errors.New("temporary path changed; refusing cleanup")
	}
	return os.Remove(path)
}
