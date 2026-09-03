const path = require('path');
const fs = require('fs');

const pdfGen = require('../dist/generators/pdfGenerator');

async function run() {
  const profilesDir = path.join(__dirname, '../data/profiles');
  const profileId = '678d07c6-14a1-4f52-af57-ded5b2527c23';
  const profilePath = path.join(profilesDir, `${profileId}.json`);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  const templatePath = path.join(__dirname, '../data/templates/default.json');
  const templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const template = { htmlContent: templateJson.htmlContent, cssContent: templateJson.cssContent };

  // Construct tailoredContent from the attachment-like jobAnalysis
  const jobAnalysis = {
    requiredSkills:["Python","Elixir","JavaScript","SQL","dbt","scalable systems","backend","frontend","data pipeline"],
    preferredSkills:["Shopify","Channel Advisor","Magento","ecommerce SAAS products","domain driven design"],
    softSkills:["high ownership mentality","product-minded","driving clarity","high autonomy","technical excellence","comfortable navigating ambiguity","collaboration mindset","excellent communication skills","lifelong learning","passion"]
  };

  const combinedHard = [...(jobAnalysis.requiredSkills||[]), ...(jobAnalysis.preferredSkills||[])];
  const hardSkills = Array.from(new Set(combinedHard)).slice(0, 20);
  const softSkills = (jobAnalysis.softSkills||[]).slice(0,5);

  const tailoredContent = {
    title: profile.title || '',
    summary: profile.summary || '',
    experience: profile.experience || [],
    skills: hardSkills,
    hardSkills,
    softSkills,
    strengths: profile.strengths || []
  };

  const html = await pdfGen.generatePreviewHTML(profile, template, tailoredContent);
  const outPath = path.join(__dirname, '../generated/preview_test.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Preview written to', outPath);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
