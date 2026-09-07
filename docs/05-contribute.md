# Contribute

Changes should preserve behavior while deepening ownership. Prefer a module that hides a difficult policy over a pass-through module that only renames calls.

The test taxonomy follows the kind of promise being protected. Small pure behavior belongs close to the domain. Cross-module invariants belong at contracts. Host and storage journeys belong at integration. Browser interaction belongs end to end. Performance and packaging each keep their own evidence.

Every test declares the capability it protects beside the executable code. The generated test map is therefore the current inventory; prose does not maintain a second list.

Before handing off a change, regenerate build artifacts, run the structural checks, and run the relevant tiers. A complete change includes its migrations, committed documentation output, and regression test; ignored bundle output is rebuilt by installs and packaging.

Comments should explain why a boundary, gesture owner, security control, or compatibility rule exists. Keep those comments with the mechanism when code moves.
