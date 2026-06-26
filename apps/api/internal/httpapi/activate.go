package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

const maxActivateBody = 16 << 10

type activateReq struct {
	Key    string `json:"key"`
	Device string `json:"device"`
	Label  string `json:"label"`
}

type tokenResp struct {
	Token         string `json:"token"`
	Exp           int64  `json:"exp"`
	Plan          string `json:"plan"`
	Seats         int    `json:"seats"`
	ActiveDevices int    `json:"activeDevices"`
}

func (s *Server) validateKeyDevice(w http.ResponseWriter, req activateReq) (string, string, bool) {
	key := license.NormalizeKey(req.Key)
	if key == "" || !validField(key, 64) {
		writeErr(w, http.StatusBadRequest, "bad_key", "missing or invalid license key")
		return "", "", false
	}
	if req.Device == "" || !validField(req.Device, 128) {
		writeErr(w, http.StatusBadRequest, "bad_device", "missing or invalid device id")
		return "", "", false
	}
	if !validField(req.Label, 64) {
		writeErr(w, http.StatusBadRequest, "bad_label", "invalid label")
		return "", "", false
	}
	return key, req.Device, true
}

func (s *Server) signFor(lic store.License, device string) (string, int64, error) {
	claims := license.NewClaims(lic.Key, device, lic.Plan, s.now(), s.cfg.EntitlementTTL)
	tok, err := license.Sign(s.cfg.SigningSeed, claims)
	return tok, claims.Exp, err
}

func (s *Server) handleActivate(w http.ResponseWriter, r *http.Request) {
	var req activateReq
	if !decodeJSON(w, r, maxActivateBody, &req) {
		return
	}
	key, device, ok := s.validateKeyDevice(w, req)
	if !ok {
		return
	}

	dev, lic, err := s.store.ActivateDevice(r.Context(), key, device, req.Label, s.now())
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "unknown_key", "no such license key")
		return
	case errors.Is(err, store.ErrLicenseInactive):
		writeErr(w, http.StatusForbidden, "inactive", "license is no longer active")
		return
	case errors.Is(err, store.ErrSeatsExceeded):
		writeErr(w, http.StatusConflict, "seats_exceeded", "all device seats are in use; deactivate one first")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", "activation failed")
		return
	}
	_ = dev

	tok, exp, err := s.signFor(lic, device)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not sign entitlement")
		return
	}
	active, _ := s.store.ActiveDeviceCount(r.Context(), key)
	writeJSON(w, http.StatusOK, tokenResp{Token: tok, Exp: exp, Plan: lic.Plan, Seats: lic.Seats, ActiveDevices: active})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req activateReq
	if !decodeJSON(w, r, maxActivateBody, &req) {
		return
	}
	key, device, ok := s.validateKeyDevice(w, req)
	if !ok {
		return
	}

	lic, err := s.store.RefreshDevice(r.Context(), key, device, s.now())
	switch {
	case errors.Is(err, store.ErrNotFound):
		// license unknown OR this device's seat was released → client must re-activate
		writeErr(w, http.StatusNotFound, "reactivate", "device is not active for this license")
		return
	case errors.Is(err, store.ErrLicenseInactive):
		writeErr(w, http.StatusForbidden, "inactive", "license is no longer active")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", "refresh failed")
		return
	}

	tok, exp, err := s.signFor(lic, device)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not sign entitlement")
		return
	}
	writeJSON(w, http.StatusOK, tokenResp{Token: tok, Exp: exp, Plan: lic.Plan, Seats: lic.Seats})
}

func (s *Server) handleDeactivate(w http.ResponseWriter, r *http.Request) {
	var req activateReq
	if !decodeJSON(w, r, maxActivateBody, &req) {
		return
	}
	key, device, ok := s.validateKeyDevice(w, req)
	if !ok {
		return
	}
	if err := s.store.DeactivateDevice(r.Context(), key, device, s.now()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "unknown_device", "no such device for this license")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", "deactivation failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// historyMetrics is a CLOSED set of derived numbers — never free-form JSON. The decoder
// (DisallowUnknownFields, recursive) rejects any other field, so invariant 1 ("derived metrics only,
// never asset bytes") is enforced by the type, not by a comment. We re-marshal this exact shape for
// storage, so nothing a client invents can land in the table.
type historyMetrics struct {
	DiskBytesBefore int64 `json:"diskBytesBefore"`
	DiskBytesAfter  int64 `json:"diskBytesAfter"`
	VramBytesBefore int64 `json:"vramBytesBefore"`
	VramBytesAfter  int64 `json:"vramBytesAfter"`
	Findings        int   `json:"findings"`
	SavedPct        int   `json:"savedPct"`
}

type historyReq struct {
	Key     string         `json:"key"`
	Device  string         `json:"device"`
	Metrics historyMetrics `json:"metrics"`
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.HistoryEnabled {
		writeErr(w, http.StatusNotFound, "disabled", "history is not enabled")
		return
	}
	var req historyReq
	if !decodeJSON(w, r, 8<<10, &req) { // small cap — these are six integers
		return
	}
	key, device, ok := s.validateKeyDevice(w, activateReq{Key: req.Key, Device: req.Device})
	if !ok {
		return
	}
	// must be a live device on an active license
	if _, err := s.store.RefreshDevice(r.Context(), key, device, s.now()); err != nil {
		writeErr(w, http.StatusForbidden, "not_entitled", "device is not entitled")
		return
	}
	// store only the validated numeric shape (never the raw request bytes)
	payload, err := json.Marshal(req.Metrics)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not encode metrics")
		return
	}
	if err := s.store.RecordMetric(r.Context(), key, s.now().Unix(), string(payload)); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not record metrics")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleKeyBySession lets the Stripe success page retrieve the freshly-minted key by its (high-entropy,
// buyer-only) checkout session id, so we deliver the key without an email provider. Returns 404 until
// the webhook has fulfilled the session (the page polls briefly).
func (s *Server) handleKeyBySession(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("session_id")
	if sid == "" || !validField(sid, 128) {
		writeErr(w, http.StatusBadRequest, "bad_session", "missing session_id")
		return
	}
	lic, err := s.store.GetLicenseBySession(r.Context(), sid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "pending", "no license for this session yet")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": lic.Key, "plan": lic.Plan, "seats": lic.Seats})
}
