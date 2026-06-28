// Command devmint inserts (or deletes) an ACTIVE license directly in the SQLite DB, for LOCAL DEV and
// testing only — production licenses are minted exclusively by the Stripe webhook. It opens the DB with
// the same WAL DSN as the server, so it can run safely against a live (containerized) backend.
//
//	go run ./tools/devmint -db ~/assetdoctor/data/asset-doctor.db                 # mint a fresh key
//	go run ./tools/devmint -db ~/assetdoctor/data/asset-doctor.db -key AD-DEV-... # mint/reactivate a fixed key
//	go run ./tools/devmint -db ~/assetdoctor/data/asset-doctor.db -key AD-DEV-... -delete
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
	_ "modernc.org/sqlite"
)

func main() {
	dbPath := flag.String("db", "", "path to asset-doctor.db (required)")
	key := flag.String("key", "", "license key to mint/delete (default: generate a random one)")
	plan := flag.String("plan", "pro", "license plan")
	seats := flag.Int("seats", 3, "device seats")
	del := flag.Bool("delete", false, "delete the key (and its devices/fulfillments) instead of minting")
	flag.Parse()

	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "devmint: -db is required")
		os.Exit(2)
	}
	if err := run(*dbPath, *key, *plan, *seats, *del); err != nil {
		fmt.Fprintln(os.Stderr, "devmint:", err)
		os.Exit(1)
	}
}

func run(dbPath, key, plan string, seats int, del bool) error {
	// Same DSN the server uses → WAL + busy_timeout lets this coexist with a running container.
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer db.Close()

	if del {
		if key == "" {
			return fmt.Errorf("-delete needs -key")
		}
		k := license.NormalizeKey(key)
		_, _ = db.Exec(`DELETE FROM devices WHERE license_key = ?`, k)
		_, _ = db.Exec(`DELETE FROM fulfillments WHERE license_key = ?`, k)
		if _, err := db.Exec(`DELETE FROM licenses WHERE key = ?`, k); err != nil {
			return err
		}
		fmt.Println("deleted", k)
		return nil
	}

	if key == "" {
		k, err := license.NewKey()
		if err != nil {
			return err
		}
		key = k
	}
	k := license.NormalizeKey(key)
	now := time.Now().Unix()
	// Upsert keeps any existing device seats; just (re)activates the license.
	if _, err := db.Exec(
		`INSERT INTO licenses(key, stripe_session, stripe_customer, stripe_payment_intent, email, plan, seats, status, created_at, updated_at)
		 VALUES(?, NULL, NULL, NULL, NULL, ?, ?, 'active', ?, ?)
		 ON CONFLICT(key) DO UPDATE SET status='active', plan=excluded.plan, seats=excluded.seats, updated_at=excluded.updated_at`,
		k, plan, seats, now, now,
	); err != nil {
		return err
	}
	fmt.Println(k)
	return nil
}
