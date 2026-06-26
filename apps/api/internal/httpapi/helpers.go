package httpapi

import (
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

func b64std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// validField bounds an opaque client string (license key, device hash, label) to keep storage and
// logs sane and reject control characters. Empty is allowed only where the caller permits.
func validField(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ipLimiter is a tiny no-dependency fixed-window per-IP limiter for the activation/refresh surfaces.
// It is intentionally simple (a map of counters reset each window) — at this scale it needs no more.
type ipLimiter struct {
	mu       sync.Mutex
	hits     map[string]int
	limit    int
	window   time.Duration
	resetAt  time.Time
	clock    func() time.Time
}

func newIPLimiter(limit int, window time.Duration) *ipLimiter {
	return &ipLimiter{hits: map[string]int{}, limit: limit, window: window, clock: time.Now}
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	if now.After(l.resetAt) {
		l.hits = map[string]int{}
		l.resetAt = now.Add(l.window)
	}
	l.hits[ip]++
	return l.hits[ip] <= l.limit
}

// clientIP resolves the rate-limit key. If an operator configured a trusted ingress header
// (cfg.TrustedIPHeader, e.g. "Fly-Client-IP"), we trust THAT — the proxy overwrites it at the edge and
// the client cannot forge it through the proxy. Otherwise we use the raw TCP peer (RemoteAddr), which a
// client cannot spoof. We never trust X-Forwarded-For/X-Real-IP blindly (the deprecated-RealIP trap).
func (s *Server) clientIP(r *http.Request) string {
	if s.trustedIPHeader != "" {
		if v := r.Header.Get(s.trustedIPHeader); v != "" {
			return firstIP(v)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// firstIP takes the first token of a possibly comma-listed / host:port header value.
func firstIP(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	v = strings.TrimSpace(v)
	if host, _, err := net.SplitHostPort(v); err == nil {
		return host
	}
	return v
}
