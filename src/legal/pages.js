'use strict';

/**
 * Legal page rendering.
 *
 * The HTML lives in public/legal as plain, reviewable files. A handful of
 * placeholders are filled from configuration at request time so that contact
 * details and the effective date are never hardcoded into the copy.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const PAGES = new Set(['privacy', 'terms', 'cookies', 'accessibility', 'contact']);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function contactMarkup(config) {
  if (config.contactEmail) {
    return `<a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a>`;
  }
  return `<a href="${escapeHtml(config.contactUrl)}" rel="noreferrer noopener" target="_blank">the project issue tracker</a> (no private contact address is configured for this deployment yet)`;
}

async function loadLegalTemplates(rootDir) {
  const templates = new Map();
  for (const page of PAGES) {
    const file = path.join(rootDir, 'public', 'legal', `${page}.html`);
    const html = await fs.readFile(file, 'utf8');
    templates.set(page, html);
  }
  return templates;
}

function renderLegalPage(template, config) {
  return template
    .replaceAll('{{CONTACT}}', contactMarkup(config))
    .replaceAll('{{EFFECTIVE_DATE}}', escapeHtml(config.legalEffectiveDate))
    .replaceAll('{{OPERATOR}}', escapeHtml(config.operatorName))
    .replaceAll('{{REPO_URL}}', escapeHtml(config.repoUrl))
    .replaceAll('{{CONTACT_URL}}', escapeHtml(config.contactUrl))
    .replaceAll('{{YEAR}}', String(new Date().getFullYear()));
}

module.exports = { PAGES, loadLegalTemplates, renderLegalPage, escapeHtml };
