#!/usr/bin/env node

/**
 * retell/sync.mjs — Pull Retell agents and phone number config, commit to repo.
 *
 * This script makes the repo the source of truth for agent configuration instead
 * of the Retell dashboard. Run this whenever you update an agent or phone number
 * config in Retell, or when onboarding to pull the initial state.
 *
 * Usage:
 *   node retell/sync.mjs pull        # Download agents & phone config from Retell
 *   node retell/sync.mjs push        # Upload agents to Retell from repo config
 *   node retell/sync.mjs diff        # Show what would change
 *
 * Environment:
 *   RETELL_API_KEY      Bearer token (required, read from .dev.vars if not set)
 *   DRY_RUN             If "1", show changes without writing files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Read .dev.vars for RETELL_API_KEY if not in environment
function readDevVars() {
  try {
    const devVarsPath = path.join(REPO_ROOT, '.dev.vars');
    const content = fs.readFileSync(devVarsPath, 'utf8');
    const lines = content.split('\n');
    const vars = {};
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [key, ...valueParts] = line.split('=');
      let value = valueParts.join('=').trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
    return vars;
  } catch (e) {
    return {};
  }
}

const devVars = readDevVars();
const RETELL_API_KEY = process.env.RETELL_API_KEY || devVars.RETELL_API_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!RETELL_API_KEY) {
  console.error('Error: RETELL_API_KEY not found in environment or .dev.vars');
  process.exit(1);
}

// Retell API client
async function retellFetch(endpoint, options = {}) {
  const url = `https://api.retellai.com${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${RETELL_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  let data;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Retell API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function pullAgents() {
  console.log('Pulling agents from Retell...');

  let agents = [];
  try {
    // Try different possible endpoints
    const endpoints = [
      '/v2/get-agents',
      '/get-agents',
      '/v2/agents',
      '/agents',
      '/list-agents'
    ];

    let success = false;
    let lastError;

    for (const endpoint of endpoints) {
      try {
        console.log(`  Trying ${endpoint}...`);
        const result = await retellFetch(endpoint);

        // Check if result looks like an agent list
        if (Array.isArray(result)) {
          agents = result;
          success = true;
          console.log(`  ✓ Found ${agents.length} agent(s) via ${endpoint}`);
          break;
        } else if (result.agents && Array.isArray(result.agents)) {
          agents = result.agents;
          success = true;
          console.log(`  ✓ Found ${agents.length} agent(s) via ${endpoint}`);
          break;
        }
      } catch (e) {
        lastError = e;
      }
    }

    if (!success) {
      throw new Error(
        `Could not find working API endpoint. Last error: ${lastError?.message || 'unknown'}`
      );
    }
  } catch (e) {
    console.error(`Error pulling agents: ${e.message}`);
    console.log('\nManual fallback: Export agents from Retell dashboard:');
    console.log('  1. Go to dashboard.retellai.com/agents');
    console.log('  2. For each agent, copy its JSON config');
    console.log('  3. Save to: retell/agents/{agent-id}.json');
    process.exit(1);
  }

  // Save agents
  const agentsDir = path.join(__dirname, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  for (const agent of agents) {
    if (!agent.agent_id) {
      console.warn(`  Warning: agent missing agent_id: ${JSON.stringify(agent).slice(0, 80)}...`);
      continue;
    }

    const filePath = path.join(agentsDir, `${agent.agent_id}.json`);
    const content = JSON.stringify(agent, null, 2);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would write ${agent.agent_id} to ${filePath}`);
    } else {
      fs.writeFileSync(filePath, content + '\n', 'utf8');
      console.log(`  ✓ Saved ${agent.agent_id}`);
    }
  }

  return agents;
}

async function pullPhoneNumbers() {
  console.log('Pulling phone numbers from Retell...');

  let numbers = [];
  try {
    // Try different endpoints
    const endpoints = ['/v2/get-phone-numbers', '/get-phone-numbers', '/v2/phone-numbers', '/phone-numbers'];

    let success = false;
    let lastError;

    for (const endpoint of endpoints) {
      try {
        const result = await retellFetch(endpoint);

        if (Array.isArray(result)) {
          numbers = result;
          success = true;
          break;
        } else if (result.numbers && Array.isArray(result.numbers)) {
          numbers = result.numbers;
          success = true;
          break;
        }
      } catch (e) {
        lastError = e;
      }
    }

    if (!success) {
      throw new Error(`Could not find working endpoint. Last error: ${lastError?.message}`);
    }
  } catch (e) {
    console.warn(`Warning: Could not pull phone numbers: ${e.message}`);
    console.log('  Manual fallback: Export from Retell dashboard > Phone Numbers');
    return [];
  }

  // Save phone numbers
  const numbersDir = path.join(__dirname, 'phone-numbers');
  fs.mkdirSync(numbersDir, { recursive: true });

  for (const number of numbers) {
    if (!number.phone_number && !number.number_id) {
      console.warn(`  Warning: missing identifier: ${JSON.stringify(number).slice(0, 80)}...`);
      continue;
    }

    const id = number.phone_number?.replace(/\D/g, '') || number.number_id;
    const filePath = path.join(numbersDir, `${id}.json`);
    const content = JSON.stringify(number, null, 2);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would write ${id} to ${filePath}`);
    } else {
      fs.writeFileSync(filePath, content + '\n', 'utf8');
      console.log(`  ✓ Saved ${number.phone_number || id}`);
    }
  }

  return numbers;
}

async function pullAll() {
  console.log('=== Retell Sync: Pull ===\n');

  try {
    const agents = await pullAgents();
    console.log();
    const numbers = await pullPhoneNumbers();

    console.log(`\n✓ Pull complete: ${agents.length} agents, ${numbers.length} phone numbers`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No files were written. Remove DRY_RUN=1 to commit.');
    } else {
      console.log('\nNext: Review changes and commit.');
      console.log('  git add retell/');
      console.log('  git commit -m "Pull Retell agents and phone config"');
    }
  } catch (e) {
    console.error(`\n✗ Pull failed: ${e.message}`);
    process.exit(1);
  }
}

async function pushAgents() {
  console.log('⚠ Push not yet implemented. Manual process:');
  console.log('  1. Update agent JSON in retell/agents/{id}.json');
  console.log('  2. Go to dashboard.retellai.com/agents/{id}/config');
  console.log('  3. Paste updated JSON and save');
  console.log('  4. Re-run "node retell/sync.mjs pull" to verify');
}

const command = process.argv[2] || 'pull';

switch (command) {
  case 'pull':
    pullAll().catch(e => {
      console.error(e);
      process.exit(1);
    });
    break;
  case 'push':
    pushAgents().catch(e => {
      console.error(e);
      process.exit(1);
    });
    break;
  case 'diff':
    console.log('Diff not yet implemented. Run "git diff retell/" instead.');
    break;
  default:
    console.log('Usage: node retell/sync.mjs [pull|push|diff]');
    process.exit(1);
}
