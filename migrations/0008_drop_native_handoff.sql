-- Retires the native handoff storage from 0003. The native handoff was replaced
-- by Keycloak's Web handoff (ADR-0048) and nothing writes these tables any more.
-- Handoff codes, bridge codes and request nonces are ephemeral infrastructure
-- data, so they are hard-deleted rather than kept (CONTEXT "Deletion
-- lifecycle"); leftover rows are unusable and are dropped with their tables.
--
-- Run this manually, after the build that no longer reads these tables (the
-- readiness probe and the prune-auth job) is live everywhere. `/api/ready`
-- deliberately does not require this migration, so that build is ready both
-- before and after it runs.
--
-- The three tables have no foreign keys between them and no other object
-- references them, so they are dropped without CASCADE: an unexpected
-- dependency makes the drop fail instead of silently taking more with it.
-- Their indexes go with them. Safe to run more than once.
DROP TABLE IF EXISTS account_native_bridge_request_nonces;
DROP TABLE IF EXISTS account_native_bridges;
DROP TABLE IF EXISTS account_native_handoffs;
