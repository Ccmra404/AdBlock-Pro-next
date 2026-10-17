//go:build linux || android

package main

import (
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

func acquire(path string) (*os.File, error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func startWorker(id string) error {
	groups, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		return e
	}
	app := regexp.MustCompile(`(?m)^0::/(apps/)?uid_[0-9]+(/|$)`)
	if app.Match(groups) {
		if e = os.WriteFile("/sys/fs/cgroup/cgroup.procs", []byte(strconv.Itoa(os.Getpid())), 0600); e != nil {
			return e
		}
		groups, e = os.ReadFile("/proc/self/cgroup")
		if e != nil || !strings.Contains("\n"+string(groups), "\n0::/\n") {
			return errors.New("cannot leave app freezer")
		}
	}
	self, e := os.Executable()
	if e != nil {
		return e
	}
	cmd := exec.Command(self, "worker", id)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if e = cmd.Start(); e != nil {
		return e
	}
	return cmd.Process.Release()
}
