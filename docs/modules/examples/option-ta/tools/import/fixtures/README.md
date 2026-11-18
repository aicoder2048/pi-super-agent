# Fictional broker-import acceptance fixtures

Source: user-provided broker-exports samples and README, version 2026-11-17. All identities and trades are fictional. CSVs and expected/reconcile JSON files are copied verbatim; SQLite registries serialize aliases as text JSON and historical quantities as integers. No real database is read or modified.

`cases.json` passes only broker/csv/import_date to the actual import tool. Each data folder is an isolated registry/history snapshot. Expectations are derived from the source expected/reconcile documents and README, never captured from the implementation. Numeric display is normalized to existing four-decimal tool values; `instrument` serialization is checked separately by the work-directory test.

README precedence: stock delivery instruments omit option fields (the eTrade expected JSON instead lists null option fields). The reconcile line 5 has the same fill_id but a different price: reconcile expects conflict, while README section 7 says same-id means already-recorded and separately says price differences mean conflict. These rules are internally ambiguous; this fixture tests the explicit price-conflict scenario without claiming the ambiguity is resolved. Candidate arrays use lexical order; README does not prescribe their order. Pending status is tested on the import-date boundary. Historical increments use distinct original IDs so both reversal links and the total weighted execution are checked.

A cumulative historical last-fill ID colliding with the export aggregate ID cannot be safely replaced without a new confirmed fact key; this remains a separately reported limitation, not a passing enrichment fixture.
