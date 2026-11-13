"""Tiny static server for local development (ES modules need http://, not file://).
Run:  python serve.py   then open http://localhost:8765/

Threaded on purpose: browsers open idle speculative connections, and a one-request-at-a-time server
blocks on them while every real request waits.
"""
import http.server, sys, os
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.bin': 'application/octet-stream', '.ini': 'text/plain'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '" 200 ' not in (fmt % args):   # only report misses and errors
            sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'Faceplate Customizer at http://localhost:{PORT}/', flush=True)
    httpd.serve_forever()
