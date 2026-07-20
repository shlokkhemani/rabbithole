# Core contracts

This directory holds the hand-authored TypeScript declaration files that form
Rabbithole's shared boundary vocabulary.

Every `.d.ts` contract added here must ship with:

- a link to its runtime authority;
- a typed fixture; and
- a negative runtime test.

Runtime validation remains mandatory at trust boundaries.
