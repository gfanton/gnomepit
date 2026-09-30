// Command serve is a static file server for the page during development. It sends the
// wasm MIME type the browser needs and forbids caching so every reload sees a fresh build.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "address to listen on")
	dir := flag.String("dir", "client/web", "directory to serve")
	flag.Parse()

	files := http.FileServer(http.Dir(*dir))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
	slog.Info("serving", "dir", *dir, "url", "http://"+*addr+"/")
	if err := http.ListenAndServe(*addr, handler); err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
}
