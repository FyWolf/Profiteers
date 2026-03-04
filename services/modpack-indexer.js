/**
 * Modpack Indexer Service
 * 
 * Background service that fetches mod details from the Steam Web API.
 * Uses IPublishedFileService/GetDetails to get name, file_size, and preview image.
 * Processes mods in batches of 20 with delays to avoid rate limiting.
 */

const https = require('https');

class ModpackIndexer {
    constructor(db) {
        this.db = db;
        this.apiKey = process.env.STEAM_API_KEY;
        this.batchSize = 20;
        this.delayBetweenBatches = 1500; // ms
    }

    async startIndexing(modpackId) {
        if (!this.apiKey) {
            console.error('[ModpackIndexer] STEAM_API_KEY not set in .env');
            await this.db.query(
                `UPDATE modpacks SET index_status = 'failed', index_error = 'Steam API key not configured' WHERE id = ?`,
                [modpackId]
            );
            return;
        }

        try {
            await this.db.query(
                `UPDATE modpacks SET index_status = 'indexing', index_progress = 0, index_error = NULL WHERE id = ?`,
                [modpackId]
            );

            const [mods] = await this.db.query(
                `SELECT id, workshop_id FROM modpack_mods WHERE modpack_id = ? AND is_indexed = FALSE`,
                [modpackId]
            );

            if (mods.length === 0) {
                await this.db.query(`UPDATE modpacks SET index_status = 'completed' WHERE id = ?`, [modpackId]);
                return;
            }

            console.log(`[ModpackIndexer] Modpack ${modpackId}: Indexing ${mods.length} mods...`);
            let indexed = 0;

            for (let i = 0; i < mods.length; i += this.batchSize) {
                const batch = mods.slice(i, i + this.batchSize);

                try {
                    const details = await this.fetchBatchDetails(batch.map(m => m.workshop_id));

                    for (const mod of batch) {
                        const detail = details[mod.workshop_id.toString()];
                        if (detail) {
                            await this.db.query(
                                `UPDATE modpack_mods SET steam_name = ?, file_size = ?, icon_url = ?, is_indexed = TRUE, indexed_at = NOW() WHERE id = ?`,
                                [detail.title || null, parseInt(detail.file_size) || 0, detail.preview_url || null, mod.id]
                            );
                        } else {
                            await this.db.query(`UPDATE modpack_mods SET is_indexed = TRUE, indexed_at = NOW() WHERE id = ?`, [mod.id]);
                        }
                        indexed++;
                    }

                    await this.db.query(`UPDATE modpacks SET index_progress = ? WHERE id = ?`, [indexed, modpackId]);
                } catch (batchError) {
                    console.error(`[ModpackIndexer] Batch error:`, batchError.message);
                }

                if (i + this.batchSize < mods.length) {
                    await new Promise(r => setTimeout(r, this.delayBetweenBatches));
                }
            }

            const [sizeResult] = await this.db.query(
                `SELECT COALESCE(SUM(file_size), 0) as total_size FROM modpack_mods WHERE modpack_id = ?`,
                [modpackId]
            );

            await this.db.query(
                `UPDATE modpacks SET index_status = 'completed', total_size = ?, index_progress = ? WHERE id = ?`,
                [sizeResult[0].total_size, indexed, modpackId]
            );

            console.log(`[ModpackIndexer] Modpack ${modpackId}: Done! ${indexed} mods indexed.`);
        } catch (error) {
            console.error(`[ModpackIndexer] Fatal error:`, error);
            await this.db.query(
                `UPDATE modpacks SET index_status = 'failed', index_error = ? WHERE id = ?`,
                [error.message, modpackId]
            );
        }
    }

    async fetchBatchDetails(workshopIds) {
        const params = new URLSearchParams();
        params.append('key', this.apiKey);
        workshopIds.forEach((id, idx) => params.append(`publishedfileids[${idx}]`, id.toString()));

        const url = `https://api.steampowered.com/IPublishedFileService/GetDetails/v1?${params.toString()}`;
        const data = await this.httpGet(url);
        const result = {};

        if (data?.response?.publishedfiledetails) {
            for (const item of data.response.publishedfiledetails) {
                if (item.publishedfileid && item.result === 1) {
                    result[item.publishedfileid] = {
                        title: item.title,
                        file_size: item.file_size,
                        preview_url: item.preview_url
                    };
                }
            }
        }
        return result;
    }

    httpGet(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('Failed to parse Steam API response')); }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Steam API timeout')); });
        });
    }

    async reindex(modpackId) {
        await this.db.query(
            `UPDATE modpack_mods SET is_indexed = FALSE, steam_name = NULL, file_size = 0, icon_url = NULL, indexed_at = NULL WHERE modpack_id = ?`,
            [modpackId]
        );
        await this.startIndexing(modpackId);
    }
}

module.exports = ModpackIndexer;
