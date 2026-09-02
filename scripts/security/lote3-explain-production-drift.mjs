#!/usr/bin/env node
// Diagnostic companion for the read-only preflight. The raw baseline path is
// intentionally external/untracked because it contains full function source.
import { readFileSync } from 'node:fs'

const baselinePath = process.argv[2]
if (!baselinePath) throw new Error('usage: ... <raw-before-catalog.json>')
const before = JSON.parse(readFileSync(baselinePath,'utf8').replace(/^\uFEFF/,''))
let input=''
for await (const chunk of process.stdin) input+=chunk
const after=JSON.parse(input.replace(/^\uFEFF/,''))
const beforeFunctions=before.rows[0].catalog.functions
const afterFunctions=after.rows[0].catalog.functions
const key=f=>`${f.name}(${f.identity_arguments})`
const afterByKey=new Map(afterFunctions.map(f=>[key(f),f]))

for(const oldFn of beforeFunctions){
  const newFn=afterByKey.get(key(oldFn))
  if(!newFn || oldFn.definition.replace(/\r\n/g,'\n')===newFn.definition.replace(/\r\n/g,'\n')) continue
  const a=oldFn.definition.replace(/\r\n/g,'\n').split('\n')
  const b=newFn.definition.replace(/\r\n/g,'\n').split('\n')
  let prefix=0
  while(prefix<a.length && prefix<b.length && a[prefix]===b[prefix]) prefix++
  let suffix=0
  while(suffix<a.length-prefix && suffix<b.length-prefix && a[a.length-1-suffix]===b[b.length-1-suffix]) suffix++
  console.log(`=== ${key(oldFn)} ===`)
  console.log(`common prefix lines=${prefix}; common suffix lines=${suffix}`)
  console.log('--- before changed region')
  for(const line of a.slice(prefix,a.length-suffix)) console.log(`- ${line}`)
  console.log('+++ current production changed region')
  for(const line of b.slice(prefix,b.length-suffix)) console.log(`+ ${line}`)
}
