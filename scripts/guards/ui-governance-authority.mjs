import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const agentsPath = resolve(repoRoot, 'AGENTS.md')

let instructions

try {
  instructions = readFileSync(agentsPath, 'utf8')
} catch {
  console.error('UI governance guard failed: root AGENTS.md is missing or unreadable.')
  process.exit(1)
}

const requiredReferences = [
  '.claude/skills/techrepair-product-design/SKILL.md',
  '.claude/skills/techrepair-product-design/references/engineering-safety.md',
  'DESIGN_SYSTEM.md',
]

const missingReferences = requiredReferences.filter((reference) => !instructions.includes(reference))
const identifiesSecondaryStatus = /DESIGN_SYSTEM\.md[^\n]*(secondary|historical)/i.test(instructions)

if (missingReferences.length > 0 || !identifiesSecondaryStatus) {
  console.error('UI governance guard failed: AGENTS.md must preserve canonical UI authority discoverability.')

  for (const reference of missingReferences) {
    console.error(`- Missing reference: ${reference}`)
  }

  if (!identifiesSecondaryStatus) {
    console.error('- DESIGN_SYSTEM.md must be identified as secondary or historical.')
  }

  process.exit(1)
}

console.log('UI governance guard passed: canonical product-design authority is agent-visible.')
