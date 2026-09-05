export const productionMaintainabilityRules = {
  complexity: ["error", { max: 30, variant: "modified" }],
  "max-lines-per-function": [
    "error",
    { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
};

export const testMaintainabilityRules = {
  complexity: "off",
  "max-lines-per-function": [
    "error",
    { max: 450, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  "max-lines": ["error", { max: 1_200, skipBlankLines: true, skipComments: true }],
};
