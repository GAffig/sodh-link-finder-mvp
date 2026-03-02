export const INDICATOR_ALIAS_RULES = Object.freeze([
  Object.freeze({
    id: "chronic_absenteeism",
    triggerPhrases: Object.freeze([
      "chronic absent",
      "chronic absence",
      "absent rate",
      "school absence"
    ]),
    expansionPhrases: Object.freeze([
      "chronic absenteeism",
      "school attendance"
    ])
  }),
  Object.freeze({
    id: "uninsured",
    triggerPhrases: Object.freeze([
      "uninsured",
      "uninsured rate",
      "no health insurance"
    ]),
    expansionPhrases: Object.freeze([
      "health insurance coverage"
    ])
  }),
  Object.freeze({
    id: "incarceration",
    triggerPhrases: Object.freeze([
      "incarceration",
      "incarcerated",
      "jail",
      "prison"
    ]),
    expansionPhrases: Object.freeze([
      "corrections",
      "justice system"
    ])
  }),
  Object.freeze({
    id: "food_insecurity",
    triggerPhrases: Object.freeze([
      "food insecurity",
      "food insecure",
      "food desert"
    ]),
    expansionPhrases: Object.freeze([
      "nutrition access"
    ])
  }),
  Object.freeze({
    id: "life_expectancy",
    triggerPhrases: Object.freeze([
      "life expectancy"
    ]),
    expansionPhrases: Object.freeze([
      "mortality"
    ])
  }),
  Object.freeze({
    id: "opportunity_atlas",
    triggerPhrases: Object.freeze([
      "opportunity atlas",
      "income mobility",
      "social mobility"
    ]),
    expansionPhrases: Object.freeze([
      "opportunity insights"
    ])
  })
]);
