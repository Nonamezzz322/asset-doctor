// Package store is the thin SQLite persistence layer for licenses/devices/fulfillments.
// A single writer connection (MaxOpenConns=1) serializes all access — at entitlement-backend scale
// this trivially eliminates SQLITE_BUSY and makes the activation seat-check atomic without explicit
// locking gymnastics. WAL + foreign keys are enabled via the DSN.
package store

import (
	"context"
	_ "embed"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

var (
	ErrNotFound       = errors.New("store: not found")
	ErrLicenseInactive = errors.New("store: license is not active")
	ErrSeatsExceeded  = errors.New("store: device seat limit reached")
)

type Store struct{ db *sql.DB }

type License struct {
	Key             string
	StripeSession   string
	StripeCustomer  string
	StripePaymentIntent string
	Email           string
	Plan            string
	Seats           int
	Status          string
	CreatedAt       int64
	UpdatedAt       int64
}

type Device struct {
	LicenseKey  string
	DeviceHash  string
	Label       string
	ActivatedAt int64
	LastSeenAt  int64
	RevokedAt   sql.NullInt64
}

func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // serialize: tiny scale, atomic seat-checks, zero SQLITE_BUSY
	if err := db.Ping(); err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(schemaSQL)
	return err
}

// FulfillCheckout idempotently mints a license for a Stripe event. If the event was already
// processed (PK on fulfillments), it returns the existing license key and created=false. The
// license key is produced by mintKey (injected so tests are deterministic; nil → crypto-random).
func (s *Store) FulfillCheckout(
	ctx context.Context,
	eventID string,
	lic License,
	mintKey func() (string, error),
	now time.Time,
) (key string, created bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback() }()

	// Already fulfilled this event?
	var existing string
	switch err := tx.QueryRowContext(ctx, `SELECT license_key FROM fulfillments WHERE event_id = ?`, eventID).Scan(&existing); err {
	case nil:
		return existing, false, tx.Commit()
	case sql.ErrNoRows:
		// fall through to mint
	default:
		return "", false, err
	}

	// Same checkout session already minted under a different event? Reuse it.
	if lic.StripeSession != "" {
		var prior string
		switch err := tx.QueryRowContext(ctx, `SELECT key FROM licenses WHERE stripe_session = ?`, lic.StripeSession).Scan(&prior); err {
		case nil:
			if _, e := tx.ExecContext(ctx, `INSERT OR IGNORE INTO fulfillments(event_id, license_key, created_at) VALUES(?,?,?)`, eventID, prior, now.Unix()); e != nil {
				return "", false, e
			}
			return prior, false, tx.Commit()
		case sql.ErrNoRows:
		default:
			return "", false, err
		}
	}

	k, err := mintKey()
	if err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO licenses(key, stripe_session, stripe_customer, stripe_payment_intent, email, plan, seats, status, created_at, updated_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?)`,
		k, nullStr(lic.StripeSession), nullStr(lic.StripeCustomer), nullStr(lic.StripePaymentIntent), nullStr(lic.Email),
		def(lic.Plan, "pro"), defInt(lic.Seats, 3), "active", now.Unix(), now.Unix(),
	); err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO fulfillments(event_id, license_key, created_at) VALUES(?,?,?)`, eventID, k, now.Unix()); err != nil {
		return "", false, err
	}
	return k, true, tx.Commit()
}

func (s *Store) GetLicense(ctx context.Context, key string) (License, error) {
	var l License
	var sess, cust, pi, email sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT key, stripe_session, stripe_customer, stripe_payment_intent, email, plan, seats, status, created_at, updated_at
		 FROM licenses WHERE key = ?`, key).
		Scan(&l.Key, &sess, &cust, &pi, &email, &l.Plan, &l.Seats, &l.Status, &l.CreatedAt, &l.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrNotFound
	}
	if err != nil {
		return l, err
	}
	l.StripeSession, l.StripeCustomer, l.StripePaymentIntent, l.Email = sess.String, cust.String, pi.String, email.String
	return l, nil
}

// GetLicenseBySession resolves a license from its Stripe checkout session id (success-page lookup).
func (s *Store) GetLicenseBySession(ctx context.Context, sessionID string) (License, error) {
	var key string
	err := s.db.QueryRowContext(ctx, `SELECT key FROM licenses WHERE stripe_session = ?`, sessionID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return License{}, ErrNotFound
	}
	if err != nil {
		return License{}, err
	}
	return s.GetLicense(ctx, key)
}

// ActivateDevice enforces the seat limit atomically and returns the resulting device row.
// Re-activating an already-active device is idempotent and consumes no extra seat.
func (s *Store) ActivateDevice(ctx context.Context, key, deviceHash, label string, now time.Time) (Device, License, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Device{}, License{}, err
	}
	defer func() { _ = tx.Rollback() }()

	lic, err := scanLicenseTx(ctx, tx, key)
	if err != nil {
		return Device{}, License{}, err
	}
	if lic.Status != "active" {
		return Device{}, lic, ErrLicenseInactive
	}

	var revoked sql.NullInt64
	var existing bool
	switch err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM devices WHERE license_key = ? AND device_hash = ?`, key, deviceHash).Scan(&revoked); err {
	case nil:
		existing = true
	case sql.ErrNoRows:
		existing = false
	default:
		return Device{}, lic, err
	}

	if existing && !revoked.Valid {
		// already holds a seat → just touch
		if _, err := tx.ExecContext(ctx, `UPDATE devices SET last_seen_at = ?, label = COALESCE(NULLIF(?,''), label) WHERE license_key = ? AND device_hash = ?`, now.Unix(), label, key, deviceHash); err != nil {
			return Device{}, lic, err
		}
	} else {
		// new device OR re-claiming a revoked seat → must fit under the seat cap
		var active int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE license_key = ? AND revoked_at IS NULL`, key).Scan(&active); err != nil {
			return Device{}, lic, err
		}
		if active >= lic.Seats {
			return Device{}, lic, ErrSeatsExceeded
		}
		if existing {
			if _, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = NULL, last_seen_at = ?, activated_at = ?, label = ? WHERE license_key = ? AND device_hash = ?`, now.Unix(), now.Unix(), label, key, deviceHash); err != nil {
				return Device{}, lic, err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `INSERT INTO devices(license_key, device_hash, label, activated_at, last_seen_at) VALUES(?,?,?,?,?)`, key, deviceHash, label, now.Unix(), now.Unix()); err != nil {
				return Device{}, lic, err
			}
		}
	}

	dev, err := scanDeviceTx(ctx, tx, key, deviceHash)
	if err != nil {
		return Device{}, lic, err
	}
	return dev, lic, tx.Commit()
}

// RefreshDevice re-validates for /v1/refresh: the license must be active and the device must hold a
// live seat (not revoked). It does NOT create or re-claim seats — refresh only renews, never grants.
func (s *Store) RefreshDevice(ctx context.Context, key, deviceHash string, now time.Time) (License, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return License{}, err
	}
	defer func() { _ = tx.Rollback() }()

	lic, err := scanLicenseTx(ctx, tx, key)
	if err != nil {
		return License{}, err
	}
	if lic.Status != "active" {
		return lic, ErrLicenseInactive
	}
	var revoked sql.NullInt64
	switch err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM devices WHERE license_key = ? AND device_hash = ?`, key, deviceHash).Scan(&revoked); err {
	case nil:
		if revoked.Valid {
			return lic, ErrNotFound // seat was released → client must re-activate
		}
	case sql.ErrNoRows:
		return lic, ErrNotFound
	default:
		return lic, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE license_key = ? AND device_hash = ?`, now.Unix(), key, deviceHash); err != nil {
		return lic, err
	}
	return lic, tx.Commit()
}

// DeactivateDevice releases a seat (idempotent).
func (s *Store) DeactivateDevice(ctx context.Context, key, deviceHash string, now time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE license_key = ? AND device_hash = ? AND revoked_at IS NULL`, now.Unix(), key, deviceHash)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// nothing live to release — treat as success only if the device row exists at all
		var one int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE license_key = ? AND device_hash = ?`, key, deviceHash).Scan(&one); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
	}
	return nil
}

// SetStatus flips a license to refunded/revoked (kill-switch). Returns ErrNotFound if no such key.
func (s *Store) SetStatus(ctx context.Context, key, status string, now time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE licenses SET status = ?, updated_at = ? WHERE key = ?`, status, now.Unix(), key)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetStatusByPaymentIntent is how refund webhooks (which carry a payment_intent, not our key) reach a
// license. Returns the affected key and ErrNotFound if none matched.
func (s *Store) SetStatusByPaymentIntent(ctx context.Context, pi, status string, now time.Time) (string, error) {
	if pi == "" {
		return "", ErrNotFound
	}
	var key string
	err := s.db.QueryRowContext(ctx, `SELECT key FROM licenses WHERE stripe_payment_intent = ?`, pi).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE licenses SET status = ?, updated_at = ? WHERE key = ?`, status, now.Unix(), key); err != nil {
		return "", err
	}
	return key, nil
}

// ActiveDeviceCount is a small read used by /v1/activate responses and tests.
func (s *Store) ActiveDeviceCount(ctx context.Context, key string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE license_key = ? AND revoked_at IS NULL`, key).Scan(&n)
	return n, err
}

// RecordMetric appends an opt-in metric row (derived numbers only).
func (s *Store) RecordMetric(ctx context.Context, key string, ts int64, payload string) error {
	if _, err := s.GetLicense(ctx, key); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO metric_history(license_key, ts, payload) VALUES(?,?,?)`, key, ts, payload)
	return err
}

func scanLicenseTx(ctx context.Context, tx *sql.Tx, key string) (License, error) {
	var l License
	var sess, cust, pi, email sql.NullString
	err := tx.QueryRowContext(ctx,
		`SELECT key, stripe_session, stripe_customer, stripe_payment_intent, email, plan, seats, status, created_at, updated_at
		 FROM licenses WHERE key = ?`, key).
		Scan(&l.Key, &sess, &cust, &pi, &email, &l.Plan, &l.Seats, &l.Status, &l.CreatedAt, &l.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrNotFound
	}
	if err != nil {
		return l, err
	}
	l.StripeSession, l.StripeCustomer, l.StripePaymentIntent, l.Email = sess.String, cust.String, pi.String, email.String
	return l, nil
}

func scanDeviceTx(ctx context.Context, tx *sql.Tx, key, deviceHash string) (Device, error) {
	var d Device
	var label sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT license_key, device_hash, label, activated_at, last_seen_at, revoked_at FROM devices WHERE license_key = ? AND device_hash = ?`, key, deviceHash).
		Scan(&d.LicenseKey, &d.DeviceHash, &label, &d.ActivatedAt, &d.LastSeenAt, &d.RevokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotFound
	}
	d.Label = label.String
	return d, err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func def(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
func defInt(n, d int) int {
	if n <= 0 {
		return d
	}
	return n
}
