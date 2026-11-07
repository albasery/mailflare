import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const script=resolve('scripts/prepare-upstream-update.sh');
function repo(t){
 const cwd=mkdtempSync(join(tmpdir(),'mailflare-merge-test-'));
 t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');
 writeFileSync(join(cwd,'app.txt'),'base\n');git('add','.');git('commit','-m','base');git('branch','upstream');
 return {cwd,git};
}
test('upstream update keeps local customizations and leaves main unchanged',t=>{
 const {cwd,git}=repo(t);
 writeFileSync(join(cwd,'custom.txt'),'our configuration\n');git('add','.');git('commit','-m','custom');
 const base=git('rev-parse','main');
 git('switch','upstream');writeFileSync(join(cwd,'app.txt'),'upstream fix\n');git('commit','-am','fix');git('switch','main');
 execFileSync('bash',[script,'upstream','updates/test'],{cwd,stdio:'pipe'});
 assert.equal(git('rev-parse','main'),base);
 assert.equal(readFileSync(join(cwd,'custom.txt'),'utf8'),'our configuration\n');
 assert.equal(readFileSync(join(cwd,'app.txt'),'utf8'),'upstream fix\n');
});
test('conflicting upstream changes abort without replacing custom code',t=>{
 const {cwd,git}=repo(t);
 writeFileSync(join(cwd,'app.txt'),'our implementation\n');git('commit','-am','custom');const base=git('rev-parse','main');
 git('switch','upstream');writeFileSync(join(cwd,'app.txt'),'conflicting upstream\n');git('commit','-am','upstream');git('switch','main');
 assert.throws(()=>execFileSync('bash',[script,'upstream','updates/conflict'],{cwd,stdio:'pipe'}));
 assert.equal(git('rev-parse','HEAD'),base);assert.equal(git('rev-parse','main'),base);
 assert.equal(readFileSync(join(cwd,'app.txt'),'utf8'),'our implementation\n');
 assert.equal(git('status','--porcelain'),'');
});
