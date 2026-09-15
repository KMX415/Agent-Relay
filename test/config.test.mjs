import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredRepo } from '../config.mjs';
import { GitHubStore } from '../github.mjs';
test('explicit environment wins over saved configuration',()=>{
  assert.equal(configuredRepo({AGENT_MAILBOX_REPO:'owner/other'},()=>'{"repo":"owner/saved"}'),'owner/other');
});
test('saved configuration is used without a hardcoded project fallback',()=>{
  assert.equal(configuredRepo({},()=>'{"repo":"owner/saved"}'),'owner/saved');
  assert.throws(()=>configuredRepo({},()=>{throw Object.assign(new Error(),{code:'ENOENT'});}),/Choose a private/);
  assert.throws(()=>configuredRepo({},()=>'{broken'),SyntaxError);
  assert.throws(()=>new GitHubStore('../wrong'),/owner\/name/);
});
