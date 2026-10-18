//go:build linux || android

package main

import (
	"path/filepath"
	"testing"
)

func TestAIWorkerLockIsExclusiveAndReleased(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ai-worker.lock")
	a, e := acquire(p)
	if e != nil {
		t.Fatal(e)
	}
	b, e := acquire(p)
	if e == nil {
		b.Close()
		t.Fatal("concurrent AI request allowed")
	}
	a.Close()
	c, e := acquire(p)
	if e != nil {
		t.Fatal("lock not released", e)
	}
	c.Close()
}
