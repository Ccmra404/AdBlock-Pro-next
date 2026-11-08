//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

func withStateMigrationLock(path string, action func() error) error {
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return fmt.Errorf("open migration lock: %w", err)
	}
	lock := os.NewFile(uintptr(fd), path)
	defer lock.Close()
	info, err := lock.Stat()
	if err != nil {
		return fmt.Errorf("inspect migration lock: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("migration lock path is not a regular file")
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return errors.New("another state migration is already running")
		}
		return fmt.Errorf("lock migration state: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if err := syncStateDirectory(filepath.Dir(path)); err != nil {
		return fmt.Errorf("sync state directory containing migration lock: %w", err)
	}
	return action()
}

func exchangeStateDirectories(oldPath, newPath string) error {
	var number uintptr
	switch runtime.GOARCH {
	case "arm64":
		number = 276
	case "amd64":
		number = 316
	default:
		return fmt.Errorf("renameat2 is unsupported on Linux architecture %q", runtime.GOARCH)
	}
	oldName, err := syscall.BytePtrFromString(oldPath)
	if err != nil {
		return err
	}
	newName, err := syscall.BytePtrFromString(newPath)
	if err != nil {
		return err
	}
	const atFDCWD = ^uintptr(99) // -100
	const renameExchange = 2
	_, _, errno := syscall.RawSyscall6(
		number,
		atFDCWD, uintptr(unsafe.Pointer(oldName)),
		atFDCWD, uintptr(unsafe.Pointer(newName)),
		renameExchange, 0,
	)
	if errno != 0 {
		return fmt.Errorf("renameat2(RENAME_EXCHANGE): %w", errno)
	}
	return nil
}

func syncStateDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}
