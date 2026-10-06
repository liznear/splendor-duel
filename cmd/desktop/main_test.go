package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"splender/internal/httpapi"
	"splender/public"
)

func TestEmbeddedUIServed(t *testing.T) {
	srv := httptest.NewServer(httpapi.NewHandlerFS(httpapi.NewService(t.TempDir(), 1), public.Files))
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status %d", resp.StatusCode)
	}
	page, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "<!DOCTYPE html") && !strings.Contains(string(page), "<html") {
		t.Fatalf("GET / did not return index.html: %q", page[:min(len(page), 64)])
	}
}

func TestRunningInstanceDetectsEmbeddedServer(t *testing.T) {
	srv := httptest.NewServer(httpapi.NewHandlerFS(httpapi.NewService(t.TempDir(), 1), public.Files))
	defer srv.Close()
	if !runningInstance(srv.URL) {
		t.Fatal("probe should recognize a running instance")
	}
}

func TestRunningInstanceRejectsForeignAndDeadServers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	if runningInstance(srv.URL) {
		t.Fatal("probe must not claim a foreign server")
	}
	if runningInstance("http://127.0.0.1:1") {
		t.Fatal("probe must not claim a dead port")
	}
}
