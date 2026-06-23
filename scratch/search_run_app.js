const fs = require('fs');
const path = require('path');

function searchDir(dir, query) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== '.wrangler' && file !== 'scratch') {
        searchDir(fullPath, query);
      }
    } else if (file.endsWith('.js') || file.endsWith('.html') || file.endsWith('.toml')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.toLowerCase().includes(query.toLowerCase())) {
        console.log(`Found in: ${fullPath}`);
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            console.log(`  Line ${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
}

searchDir('c:/Users/benjamin.laurens/Desktop/screener/TEST', 'getgeminianalysis');
searchDir('c:/Users/benjamin.laurens/Desktop/screener/TEST', 'run.app');
searchDir('c:/Users/benjamin.laurens/Desktop/screener/TEST', 'fetchgemini');
