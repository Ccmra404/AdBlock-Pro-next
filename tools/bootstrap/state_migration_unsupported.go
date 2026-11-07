//go:build !linux

package main

import "errors"

func withStateMigrationLock(string, func() error) error {
	return errors.New("state migration is supported only on Linux")
}

func exchangeStateDirectories(string, string) error {
	return errors.New("state migration is supported only on Linux")
}

func syncStateDirectory(string) error {
	return errors.New("state migration is supported only on Linux")
}
