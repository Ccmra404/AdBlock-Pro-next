package main

import (
	"errors"
	"os"
)

func acquire(path string) (*os.File, error) { return os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600) }
func startWorker(id string) error           { return errors.New("Android background worker required") }
