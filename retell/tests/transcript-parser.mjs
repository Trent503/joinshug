/**
 * retell/tests/transcript-parser.mjs — Parse and validate agent transcripts.
 *
 * Validates:
 * - One question per agent turn (never two back-to-back questions)
 * - Readbacks match caller's input (phone, address, date/time, name)
 * - Agent behavior matches spec rules
 */

/**
 * Parse a transcript string into turns (agent/caller pairs).
 * Format: "Agent: ...\nCaller: ...\nAgent: ..."
 */
export function parseTranscript(transcript) {
  const lines = transcript
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('['));

  const turns = [];
  let currentSpeaker = null;
  let currentText = '';

  for (const line of lines) {
    const match = line.match(/^(Agent|Caller):\s*(.*)$/);

    if (match) {
      const [_, speaker, text] = match;

      if (currentSpeaker && currentSpeaker !== speaker) {
        turns.push({ speaker: currentSpeaker, text: currentText.trim() });
        currentText = '';
      }

      currentSpeaker = speaker;
      currentText += (currentText ? ' ' : '') + text;
    }
  }

  if (currentSpeaker && currentText) {
    turns.push({ speaker: currentSpeaker, text: currentText.trim() });
  }

  return turns;
}

/**
 * Validate that agent turns have at most one question.
 * Returns array of violations (empty if all valid).
 */
export function validateOneQuestionPerTurn(turns) {
  const violations = [];
  const agentTurns = turns.filter(t => t.speaker === 'Agent');

  const questionPatterns = [
    /\?\s*$/, // Ends with ?
    /what\s+(?:is|are|'s|'d)/i,
    /who\s+(?:is|are)/i,
    /where\s+(?:is|are)/i,
    /when\s+(?:is|are)/i,
    /how\s+(?:is|are|do|did)/i,
    /which\s+/i,
    /can\s+(?:you|we|they)/i,
    /would\s+(?:you|work|that)/i,
    /should\s+/i,
    /tell\s+me\s+/i,
    /let\s+me\s+(?:get|confirm|book)/i
  ];

  for (let i = 0; i < agentTurns.length; i++) {
    const turn = agentTurns[i];
    let questionCount = 0;

    // Count sentences (split by periods, question marks, or conjunctions)
    const sentences = turn.text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const sentence of sentences) {
      let hasQuestion = false;

      // Check for question mark
      if (sentence.includes('?')) {
        hasQuestion = true;
      } else {
        // Check for question patterns
        for (const pattern of questionPatterns) {
          if (pattern.test(sentence)) {
            hasQuestion = true;
            break;
          }
        }
      }

      if (hasQuestion) {
        questionCount++;
      }
    }

    if (questionCount > 1) {
      violations.push(
        `Turn ${i + 1}: "${turn.text.slice(0, 60)}..." has ${questionCount} questions`
      );
    }
  }

  return violations;
}

/**
 * Validate that readbacks match expected values from caller input.
 * Readback spec: { type, contains, must_not_contain? }
 * Types: 'phone', 'address', 'date_time', 'name', 'business'
 */
export function validateReadbacks(turns, readbackSpecs) {
  const issues = [];
  const transcript = turns.map(t => t.text).join(' ').toLowerCase();

  for (const spec of readbackSpecs) {
    const containsLower = spec.contains.toLowerCase();
    const mustNotLower = (spec.must_not_contain || '').toLowerCase();

    if (!transcript.includes(containsLower)) {
      issues.push(
        `${spec.type} readback missing: expected to find "${spec.contains}"`
      );
    }

    if (mustNotLower && transcript.includes(mustNotLower)) {
      issues.push(
        `${spec.type} readback incorrect: found "${spec.must_not_contain}" but should not`
      );
    }
  }

  return issues;
}

/**
 * Extract specific fields from a transcript (helper for test assertions).
 */
export function extractFields(transcript) {
  const lower = transcript.toLowerCase();

  return {
    hasPhoneReadback: /\d{3}-\d{3}-\d{4}|(?:\+|1)?\d{10,11}/.test(lower),
    hasAddressReadback:
      /street|avenue|boulevard|drive|court|road|way|lane|circle|terrace/i.test(
        transcript
      ),
    hasDateReadback: /monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|\d{1,2}(?:st|nd|rd|th)/i.test(
      transcript
    ),
    phoneNumbers: (transcript.match(/\d{3}-\d{3}-\d{4}/g) || []).slice(-2), // Last 2
    dates: (transcript.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/gi) || []).slice(-1)
  };
}
