const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir, readJson } = require('./helpers');

test('skills JSON database supports CRUD and duplicate protection', () => {
  const dataDir = makeTempDataDir('skills');
  process.env.TAILOR_DATA_DIR = dataDir;
  const skillsDb = loadFresh('../dist/database/skillsDatabase');

  skillsDb.ensureSkillsDatabase();

  const skillsFile = path.join(dataDir, 'skills', 'skills.json');
  assert.equal(fs.existsSync(skillsFile), true);
  assert.deepEqual(readJson(skillsFile), { hard: [], soft: [] });

  assert.deepEqual(skillsDb.addSkill('hard', 'TypeScript', {
    priority: 1,
    category: 'Languages',
  }), {
    added: true,
    skill: 'TypeScript',
    type: 'hard',
  });
  assert.deepEqual(skillsDb.addSkill('hard', ' typescript '), {
    added: false,
    skill: 'typescript',
    type: 'hard',
  });
  assert.deepEqual(skillsDb.addSkill('hard', 'React'), {
    added: true,
    skill: 'React',
    type: 'hard',
  });
  assert.deepEqual(skillsDb.addSkill('soft', 'Communication'), {
    added: true,
    skill: 'Communication',
    type: 'soft',
  });

  assert.deepEqual(skillsDb.readSkills('hard'), ['TypeScript', 'React']);
  assert.deepEqual(skillsDb.readHardSkillRecords()[0], {
    skill: 'TypeScript',
    priority: 1,
    category: 'Languages',
  });
  assert.deepEqual(skillsDb.readSkills('soft'), ['Communication']);

  assert.deepEqual(skillsDb.updateSkill('hard', 'typescript', 'Node.js'), {
    updated: true,
    skill: 'Node.js',
    type: 'hard',
  });
  assert.deepEqual(skillsDb.readHardSkillRecords().find((item) => item.skill === 'Node.js'), {
    skill: 'Node.js',
    priority: 1,
    category: 'Languages',
  });
  assert.deepEqual(skillsDb.readSkills('hard'), ['Node.js', 'React']);
  assert.throws(() => skillsDb.updateSkill('hard', 'Node.js', 'react'), /Skill already exists/);
  assert.throws(() => skillsDb.updateSkill('hard', 'Missing', 'Go'), /Skill not found/);

  assert.deepEqual(skillsDb.deleteSkill('hard', 'node.js'), {
    deleted: true,
    skill: 'node.js',
    type: 'hard',
  });
  assert.deepEqual(skillsDb.readSkills('hard'), ['React']);
  assert.throws(() => skillsDb.deleteSkill('hard', 'Node.js'), /Skill not found/);

  assert.equal(skillsDb.isSkillType('hard'), true);
  assert.equal(skillsDb.isSkillType('soft'), true);
  assert.equal(skillsDb.isSkillType('other'), false);
  assert.equal(skillsDb.inferHardSkillCategory('jQuery'), 'Frameworks and Libraries');
  assert.equal(skillsDb.inferHardSkillCategory('TanStack Query'), 'Frameworks and Libraries');
  assert.equal(skillsDb.inferHardSkillCategory('Query Optimization'), 'Databases and Storage');
  assert.equal(skillsDb.inferHardSkillCategory('AWS S3'), 'Databases and Storage');
});

test('skills JSON database normalizes corrupt or malformed files to empty lists', () => {
  const dataDir = makeTempDataDir('skills-malformed');
  process.env.TAILOR_DATA_DIR = dataDir;
  const skillsDir = path.join(dataDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'skills.json'), '{"hard":"bad","soft":[1," Teamwork ","teamwork"]}\n');

  const skillsDb = loadFresh('../dist/database/skillsDatabase');

  assert.deepEqual(skillsDb.readSkills('hard'), []);
  assert.deepEqual(skillsDb.readSkills('soft'), ['Teamwork']);
});
