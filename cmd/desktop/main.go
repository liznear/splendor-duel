// Desktop entry: embeds the browser UI, serves it on a loopback port, and
// opens the default browser. A second launch detects the running instance
// through /api/v1/health and only opens a new tab, then exits.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"splender/internal/httpapi"
	"splender/public"
)

const defaultPort = "17321"

func runningInstance(base string) bool {
	client := &http.Client{Timeout: time.Second}
	resp, err := client.Get(base + "/api/v1/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		Status  string `json:"status"`
		Version int    `json:"version"`
	}
	return json.NewDecoder(resp.Body).Decode(&body) == nil && body.Status == "ok" && body.Version == 1
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		return "splender-data"
	}
	return filepath.Join(base, "splender")
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}
	base := "http://127.0.0.1:" + port
	if runningInstance(base) {
		openBrowser(base)
		log.Printf("already running at %s; opened browser", base)
		return
	}
	sessions := filepath.Join(dataDir(), "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		log.Fatal(err)
	}
	service := httpapi.NewService(sessions, max(1, runtime.GOMAXPROCS(0)/2))
	defer service.Close()
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		// ponytail: fallback port breaks single-instance detection; add a port lock file if it matters
		if ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			log.Fatal(err)
		}
		log.Printf("port %s busy, using %s", port, ln.Addr())
	}
	url := "http://" + ln.Addr().String()
	server := &http.Server{Handler: httpapi.NewHandlerFS(service, public.Files), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		service.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	openBrowser(url)
	log.Printf("Splendor Duel Arena %s (sessions: %s)", url, sessions)
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
