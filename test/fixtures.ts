export const sampleManual = `# Code: Terraform DOCS Manual

Build test-build-42

## Contents

- Sample

*Guide / Basics*

## Batteries & Charging

Use a vehicle charging station to recharge a rover battery.

### Charging safely

Call \`self.charge()\` after checking available power.

*Components / Power*

## Battery *(Component)*

The battery exposes its current \`charge\` and capacity.

### Properties

Use \`self.charge\` to read the stored energy.

##### \`charge: float\`

Stored energy in kilojoules.

\`\`\`python
### not a heading inside a fence
\`\`\`

##### \`capacity: float\`

Maximum stored energy.

### Methods

Call \`self.discharge()\` to drain it.

##### \`discharge(amount: float)\`

Drains up to \`amount\` kilojoules.

*Types / Storage*

## Battery *(Type)*

A battery value returned by inventory queries.
`;
