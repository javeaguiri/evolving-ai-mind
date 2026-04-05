// tests/fixtures/workflow-rows.js
// Mock PGC_Workflow rows — generic *_entity workflows with domain: null.
// These are the universal candidates for any domain's keyword scan (UC 1.1 fix).
export const workflowRows = [
  { id: 310, name: 'get_entity',    domain: null, intent_keywords: ['get', 'show', 'find', 'fetch', 'look up', 'search'] },
  { id: 311, name: 'list_entity',   domain: null, intent_keywords: ['list', 'show all', 'get all', 'find all', 'all']    },
  { id: 312, name: 'add_entity',    domain: null, intent_keywords: ['add', 'create', 'new', 'insert']                    },
  { id: 313, name: 'update_entity', domain: null, intent_keywords: ['update', 'edit', 'modify', 'change']                },
  { id: 314, name: 'delete_entity', domain: null, intent_keywords: ['delete', 'remove']                                   },
];
