const { resolve } = require('node:path');

try {
    process.loadEnvFile(resolve(__dirname, '../.env'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
