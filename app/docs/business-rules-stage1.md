# Catalog, cart and report reliability

## Price contract

The API continues to accept numeric ruble prices and return numeric ruble prices.
Zero remains valid. The smallest positive price is 0.01; the maximum is
21474836.47, or 2147483647 kopecks (PostgreSQL's signed integer limit).
Decimal inputs may have at most two fractional digits. Decimal strings are
accepted; exponent notation in strings and excess fractional digits are rejected.
The model parses decimal digits into integer kopecks without float multiplication
or truncation. Both create and update validate the same range and precision.
Existing stored prices are not rewritten: an already truncated historical price
cannot be repaired without an authoritative original value.

## Categories and existing rows

Supported categories are pizza and drink, recognized case-insensitively with
optional surrounding spaces. The stored label and API response are preserved:
existing Pizza/Drink rows work without rewriting data. Category limits count all
case variants together. New/updated unsupported categories are rejected. Existing
unsupported labels are not silently recategorized or deleted; an operator must
choose their correct category before those products can be purchased.
No data migration or database schema change is required.

## Durable report requests

Report creation commits a pending report and a reports.requested outbox event in
one PostgreSQL transaction. No broker operation occurs in the HTTP transaction.
The existing outbox worker publishes only committed events using the installed
Laravel RabbitMQ driver's payload format and publisher confirms. Event ID is the
stable report job message ID. An unavailable broker leaves the event retryable,
including after five publication failures; unrelated outbox events retain their
existing failure policy. Existing worker polling/batch limits bound retries.

Delivery is at least once. A crash after broker confirmation but before recording
published_at leaves a lease that the outbox worker can reclaim after five minutes;
a duplicate job must not regenerate an already completed report. This depends on
the existing outbox worker running and on durable PostgreSQL/RabbitMQ storage; it
is not a promise of exactly-once delivery or survival after losing those stores.
The HTTP response remains 202/pending; delivery can now wait for the existing
outbox worker instead of requiring a live broker during the request.

## Report processing and failures

A row lock is held for the generation transaction, including the deterministic
S3 upload to reports/{id}.jsonl. Competing generators serialize without an expiring
lease. Process death rolls back PostgreSQL and releases the lock; an S3 object
already uploaded can be safely overwritten by the next owner. Legacy processing
rows without a live lock can also be reclaimed. Deployments must drain old workers
before mixing this ownership protocol with an older generator.

The tradeoff is a database connection/transaction held during generation. Readers
see the last committed report state (normally pending) until generation finishes.
No status/resource fields are removed. Large-report transaction duration must be
measured before production capacity planning.

Storage/network/unknown operational exceptions leave pending and are rethrown for
queue retry. Invalid JSON report data raises a permanent generation exception,
commits failed and fails the actual queue job so RabbitMQ can dead-letter it.
After three exhausted transient attempts, the job failure callback records failed
and the queue retains its existing DLQ behavior. Completed reports remain completed
if completion publication fails; retry only republishes the stable completion ID.
Replaying a terminal failed report requires an explicit operator decision, not an
automatic acknowledgement or an unbounded generation loop.

## Verification boundary

Feature, Integration and the existing database-backed Unit suites must run only
against disposable PostgreSQL/RabbitMQ/MinIO services, never development services.
ReportReliabilityTest uses real broker/storage connections and process SIGKILL;
its invalid-data and repeated-publication-failure cases explicitly inject faults.
The publish-before-markPublished crash window is simulated by expiring its outbox
lease; consumer crash/redelivery is exercised with a real killed queue worker.
