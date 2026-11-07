// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-questions.test.mjs
//
// Novia's questions, answered in place. A list of questions in her message could only be
// answered by copying the whole message, or a screenshot, into a modal that then covered it.
// /proc now sends the questions as { id, text, options? }. Slack draws an answer box under
// each one, and the answers come back to /proc, which pairs each with its question.
//
// The two Slack ends are tested against each other: the blocks noviaQuestionBlocks draws are
// the blocks collectNoviaAnswers reads, so their block ids cannot drift apart.
//
// Run: node --test tests/unit/minds-eye-questions.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normaliseQuestions, lastQuestions, composeAnswersPrompt } from '../../src/proc/minds-eye.mjs';
import { noviaQuestionBlocks } from '../../src/ui/slackbot/callback.mjs';
import { collectNoviaAnswers, NOVIA_ANSWER_PREFIX, NOVIA_COMMENT_PREFIX, NOVIA_NOTE_BLOCK } from '../../src/ui/slackbot/form-fields.mjs';
import { answersEcho } from '../../src/ui/slackbot/interactive.mjs';

const questions = [
  { id: 'names', text: 'Are the three type names right?', options: ['Yes', 'No'] },
  { id: 'target', text: 'Should emergency items carry a **target quantity**?' },
];

describe('normaliseQuestions', () => {
  it('keeps id, text and options', () => {
    assert.deepEqual(normaliseQuestions(questions), questions.map(q => ({ ...q })));
  });

  it('numbers a question that has no id, and drops one with no text', () => {
    assert.deepEqual(normaliseQuestions([{ text: ' First? ' }, { id: 'x' }, { text: 'Third?', options: [] }]),
      [{ id: 'q1', text: 'First?' }, { id: 'q2', text: 'Third?' }]);
  });

  it('is empty for a respond with no questions', () => {
    assert.deepEqual(normaliseQuestions(undefined), []);
  });
});

describe('lastQuestions', () => {
  it('reads the questions of the latest respond', () => {
    const entries = [
      { role: 'assistant', content: JSON.stringify({ action: 'respond', message: 'old', questions: [{ id: 'a', text: 'Old?' }] }) },
      { role: 'user', content: 'reply' },
      { role: 'tool', content: '{}' },
      { role: 'assistant', content: JSON.stringify({ action: 'respond', message: 'new', questions }) },
    ];
    assert.deepEqual(lastQuestions(entries), questions);
  });

  it('is empty when the latest respond asked none', () => {
    assert.deepEqual(lastQuestions([
      { role: 'assistant', content: JSON.stringify({ action: 'respond', questions }) },
      { role: 'assistant', content: JSON.stringify({ action: 'respond', message: 'done' }) },
    ]), []);
  });
});

describe('composeAnswersPrompt', () => {
  it('pairs each answer with its question, numbered as shown', () => {
    const text = composeAnswersPrompt(questions, [
      { id: 'names', answer: 'Yes', comment: 'keep them short' },
      { id: 'target', answer: 'Only for emergency stock' },
    ], 'Start with the schema.');
    assert.equal(text, [
      'My answers to your questions:',
      '',
      '1. Are the three type names right?',
      'Answer: Yes',
      'Comment: keep them short',
      '',
      '2. Should emergency items carry a **target quantity**?',
      'Answer: Only for emergency stock',
      '',
      'Also: Start with the schema.',
    ].join('\n'));
  });

  it('says a question was left unanswered rather than dropping it', () => {
    assert.match(composeAnswersPrompt(questions, [{ id: 'names', answer: 'No' }]), /2\. Should[^\n]*\nAnswer: \(no answer\)/);
  });

  it('keeps an answer whose question it cannot find', () => {
    assert.match(composeAnswersPrompt([], [{ id: 'q9', answer: 'Yes' }]), /Question q9\nAnswer: Yes/);
  });
});

describe('noviaQuestionBlocks', () => {
  const blocks = noviaQuestionBlocks(questions, 30);

  it('draws each question, then its answer box; choices get radio buttons and a comment box', () => {
    assert.deepEqual(blocks.map(b => b.block_id ?? b.type), [
      'section', `${NOVIA_ANSWER_PREFIX}names`, `${NOVIA_COMMENT_PREFIX}names`,
      'section', `${NOVIA_ANSWER_PREFIX}target`,
      NOVIA_NOTE_BLOCK,
    ]);
    assert.equal(blocks[1].element.type, 'radio_buttons');
    assert.deepEqual(blocks[1].element.options.map(o => o.value), ['Yes', 'No']);
    assert.equal(blocks[4].element.type, 'plain_text_input');
  });

  it('numbers the questions, and converts their markdown for Slack', () => {
    assert.equal(blocks[0].text.text, '*1.* Are the three type names right?');
    assert.equal(blocks[3].text.text, '*2.* Should emergency items carry a *target quantity*?');
  });

  it('leaves every box optional, so a partial answer can be sent', () => {
    assert.ok(blocks.filter(b => b.type === 'input').every(b => b.optional === true));
  });

  it('uses a select past radio buttons\' ten choices', () => {
    const [, box] = noviaQuestionBlocks([{ id: 'n', text: 'Which?', options: Array.from({ length: 12 }, (_, i) => `opt ${i}`) }], 30);
    assert.equal(box.element.type, 'static_select');
  });

  it('names the questions that did not fit instead of dropping them', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}?` }));
    const drawn = noviaQuestionBlocks(many, 30);
    assert.ok(drawn.length <= 30);
    const shown = drawn.filter(b => b.block_id?.startsWith(NOVIA_ANSWER_PREFIX)).length;
    assert.equal(shown, 14);
    assert.match(drawn.at(-2).elements[0].text, /Questions 15–20 did not fit/);
    assert.equal(drawn.at(-1).block_id, NOVIA_NOTE_BLOCK);
  });
});

describe('collectNoviaAnswers reads what noviaQuestionBlocks drew', () => {
  const blocks = noviaQuestionBlocks([
    ...questions,
    { id: 'skip', text: 'A question left blank?' },
  ], 30);
  const state = {
    [`${NOVIA_ANSWER_PREFIX}names`]:   { novia_value: { type: 'radio_buttons', selected_option: { value: 'No' } } },
    [`${NOVIA_COMMENT_PREFIX}names`]:  { novia_value: { type: 'plain_text_input', value: ' call them stock ' } },
    [`${NOVIA_ANSWER_PREFIX}target`]:  { novia_value: { type: 'plain_text_input', value: 'Yes' } },
    [`${NOVIA_ANSWER_PREFIX}skip`]:    { novia_value: { type: 'plain_text_input', value: '' } },
    [NOVIA_NOTE_BLOCK]:                { novia_value: { type: 'plain_text_input', value: 'Thanks' } },
  };

  it('returns each answer in the order shown, with its displayed number', () => {
    const { answers, note } = collectNoviaAnswers(state, blocks);
    assert.deepEqual(answers, [
      { id: 'names',  position: 1, answer: 'No',  comment: 'call them stock' },
      { id: 'target', position: 2, answer: 'Yes', comment: null },
    ]);
    assert.equal(note, 'Thanks');
  });

  it('echoes the answers by number', () => {
    const { answers, note } = collectNoviaAnswers(state, blocks);
    assert.equal(answersEcho(answers, note), '🧠 1. No — call them stock\n2. Yes\nThanks');
  });

  it('finds nothing in an untouched set of boxes', () => {
    assert.deepEqual(collectNoviaAnswers({}, blocks), { answers: [], note: null });
  });
});

describe('the respond contract — tool schema and the loop', () => {
  const seed  = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
  const tools = seed.find(r => r.key === 'minds_eye_tool_schemas').content.tools;
  const loop  = readFileSync('src/proc/minds-eye.mjs', 'utf8');

  it('offers questions on respond, each needing its text', () => {
    const q = tools.find(t => t.name === 'respond').parameters.properties.questions;
    assert.equal(q.type, 'array');
    assert.deepEqual(q.items.required, ['text']);
  });

  it('offers operations on propose_schema_fix, with only reasoning required', () => {
    const p = tools.find(t => t.name === 'propose_schema_fix').parameters;
    assert.equal(p.properties.operations.type, 'array');
    assert.deepEqual(p.required, ['reasoning']);
  });

  it('stores the questions on the respond entry and sends them with the reply', () => {
    assert.match(loop, /\.\.\.\(questions\.length \? \{ questions \} : \{\}\), items: entryItems/);
    assert.match(loop, /sessionId: session\.id,\n\s*\.\.\.\(questions\.length \? \{ questions \} : \{\}\),/);
  });
});
