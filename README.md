# lakche

My solution to the KonectX technical test. Written answers are in [ANSWERS.md](ANSWERS.md).

```sh
npm install          # TypeScript deps, OpenZeppelin v5 and forge-std
npm test             # tasks 1-3 (node:test via tsx)
npm run typecheck
forge test -vv       # task 4 (needs Foundry; on macOS also `brew install libusb`)
```

| Task | Code | Tests |
| --- | --- | --- |
| 1. RADIUS authorize reply | `src/authorize.ts` | `test/authorize.test.ts` |
| 2. Accounting ingestion | `src/accounting.ts` | `test/accounting.test.ts` |
| 3. Payment events + split | `src/payments.ts` | `test/payments.test.ts` |
| 4. Cumulative claim contract | `contracts/KXTDistributor.sol` | `test/KXTDistributor.t.sol` |
| 5. Networking and ops | `ANSWERS.md` | |
