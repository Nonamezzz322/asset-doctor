package httpapi

import (
	"encoding/json"
	"net/http"
)

// errBody mirrors apps/api's shape so the gateway can pass it through verbatim: a stable machine `code`
// the client maps to localized copy, plus a non-leaky human `error`. NEVER put image bytes, file names,
// or a native stderr blob in either field.
type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errBody{Error: msg, Code: code})
}
