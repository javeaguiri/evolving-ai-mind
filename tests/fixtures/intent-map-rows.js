// tests/fixtures/intent-map-rows.js
// Mock PGC_IntentMap rows — reflects live DB state after create_domain recipes.
// Generic *_entity intent categories produced by generate_crud_workflows prompt v9.
export const intentMapRows = [
  { id: 387, pattern: 'list.recipes|list recipes|list my recipes|show recipes|show my recipes', intent_category: 'list_entity',   action_type: 'workflow' },
  { id: 388, pattern: 'get.recipes|get recipes|get my recipes|show recipe|find recipes|find my recipes|search recipes',           intent_category: 'get_entity',    action_type: 'workflow' },
  { id: 389, pattern: 'add.recipes|add recipes|add my recipes|create recipe|new recipe',        intent_category: 'add_entity',    action_type: 'workflow' },
  { id: 390, pattern: 'update.recipes|update recipes|edit recipes|edit my recipes|modify recipe', intent_category: 'update_entity', action_type: 'workflow' },
  { id: 391, pattern: 'delete.recipes|delete recipes|remove recipes|remove my recipes',         intent_category: 'delete_entity', action_type: 'workflow' },
];

// System-level intent rows — seeded at bootstrap.
export const systemIntentRows = [
  { id: 1,  pattern: 'create.domain|new.domain|build.domain',    intent_category: 'create_domain',   action_type: 'heavy_lift' },
  { id: 2,  pattern: 'create.workflow|new.workflow',             intent_category: 'create_workflow',  action_type: 'heavy_lift' },
  { id: 3,  pattern: '^help$|^/help$',                           intent_category: 'help',             action_type: 'workflow'   },
];

// Combined rows as loaded by classify-intent.mjs (all rows from PGC_IntentMap).
export const allIntentRows = [...systemIntentRows, ...intentMapRows];
