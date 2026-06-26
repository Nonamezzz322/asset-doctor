package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func counter() func() (string, error) {
	n := 0
	return func() (string, error) {
		n++
		return "AD-KEY-" + string(rune('A'+n-1)), nil
	}
}

func TestFulfillIdempotent(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Unix(1000, 0)
	mint := counter()
	lic := License{StripeSession: "cs_1", StripePaymentIntent: "pi_1", Email: "a@b.c"}

	k1, created1, err := s.FulfillCheckout(ctx, "evt_1", lic, mint, now)
	if err != nil || !created1 {
		t.Fatalf("first fulfill: key=%q created=%v err=%v", k1, created1, err)
	}
	// SAME event id (Stripe retry) → no new license
	k2, created2, err := s.FulfillCheckout(ctx, "evt_1", lic, mint, now)
	if err != nil || created2 || k2 != k1 {
		t.Fatalf("retry should be no-op: key=%q created=%v err=%v", k2, created2, err)
	}
	// DIFFERENT event id but SAME session (Stripe sometimes re-emits) → reuse license
	k3, created3, err := s.FulfillCheckout(ctx, "evt_2", lic, mint, now)
	if err != nil || created3 || k3 != k1 {
		t.Fatalf("same-session reuse failed: key=%q created=%v err=%v", k3, created3, err)
	}
}

func TestSeatLimit(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Unix(1000, 0)
	key, _, err := s.FulfillCheckout(ctx, "e", License{StripeSession: "cs", Seats: 2}, counter(), now)
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.ActivateDevice(ctx, key, "dev1", "laptop", now); err != nil {
		t.Fatalf("dev1: %v", err)
	}
	if _, _, err := s.ActivateDevice(ctx, key, "dev2", "phone", now); err != nil {
		t.Fatalf("dev2: %v", err)
	}
	// re-activating dev1 must NOT consume a seat
	if _, _, err := s.ActivateDevice(ctx, key, "dev1", "", now); err != nil {
		t.Fatalf("dev1 re-activate: %v", err)
	}
	if _, _, err := s.ActivateDevice(ctx, key, "dev3", "", now); err != ErrSeatsExceeded {
		t.Fatalf("dev3 should exceed seats, got %v", err)
	}
	// free a seat → dev3 fits
	if err := s.DeactivateDevice(ctx, key, "dev2", now); err != nil {
		t.Fatalf("deactivate dev2: %v", err)
	}
	if _, _, err := s.ActivateDevice(ctx, key, "dev3", "", now); err != nil {
		t.Fatalf("dev3 after free: %v", err)
	}
	if n, _ := s.ActiveDeviceCount(ctx, key); n != 2 {
		t.Fatalf("active count = %d, want 2", n)
	}
}

func TestRefreshAndRevoke(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Unix(1000, 0)
	key, _, _ := s.FulfillCheckout(ctx, "e", License{StripeSession: "cs", Seats: 3}, counter(), now)
	if _, _, err := s.ActivateDevice(ctx, key, "dev1", "", now); err != nil {
		t.Fatal(err)
	}

	if _, err := s.RefreshDevice(ctx, key, "dev1", now); err != nil {
		t.Fatalf("refresh active device: %v", err)
	}
	// refund kills the license → refresh declines
	if err := s.SetStatus(ctx, key, "refunded", now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RefreshDevice(ctx, key, "dev1", now); err != ErrLicenseInactive {
		t.Fatalf("refresh after refund: want inactive, got %v", err)
	}
	// re-activation also blocked while inactive
	if _, _, err := s.ActivateDevice(ctx, key, "dev1", "", now); err != ErrLicenseInactive {
		t.Fatalf("activate after refund: want inactive, got %v", err)
	}
}

func TestRefreshDeactivatedDevice(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Unix(1000, 0)
	key, _, _ := s.FulfillCheckout(ctx, "e", License{StripeSession: "cs", Seats: 3}, counter(), now)
	_, _, _ = s.ActivateDevice(ctx, key, "dev1", "", now)
	_ = s.DeactivateDevice(ctx, key, "dev1", now)
	if _, err := s.RefreshDevice(ctx, key, "dev1", now); err != ErrNotFound {
		t.Fatalf("refresh of released seat: want ErrNotFound, got %v", err)
	}
}

func TestStatusByPaymentIntent(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Unix(1000, 0)
	key, _, _ := s.FulfillCheckout(ctx, "e", License{StripeSession: "cs", StripePaymentIntent: "pi_42"}, counter(), now)
	got, err := s.SetStatusByPaymentIntent(ctx, "pi_42", "refunded", now)
	if err != nil || got != key {
		t.Fatalf("refund by PI: key=%q err=%v", got, err)
	}
	lic, _ := s.GetLicense(ctx, key)
	if lic.Status != "refunded" {
		t.Fatalf("status = %q", lic.Status)
	}
	if _, err := s.SetStatusByPaymentIntent(ctx, "pi_unknown", "refunded", now); err != ErrNotFound {
		t.Fatalf("unknown PI: want ErrNotFound, got %v", err)
	}
}

func TestUnknownKey(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, _, err := s.ActivateDevice(ctx, "AD-NOPE", "d", "", time.Unix(1, 0)); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
