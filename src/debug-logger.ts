import * as fs from 'fs';
import * as path from 'path';

export class DebugLogger {
    private logData: any[] = [];
    private enabled: boolean = false;
    private outputPath: string;

    constructor(outputDir: string, enabled: boolean) {
        this.enabled = enabled;
        this.outputPath = path.join(outputDir, 'seed-it-debug.json');
    }

    log(section: string, data: any) {
        if (!this.enabled) return;

        this.logData.push({
            timestamp: new Date().toISOString(),
            section,
            data
        });
    }

    async save() {
        if (!this.enabled || this.logData.length === 0) return;

        try {
            await fs.promises.writeFile(
                this.outputPath,
                JSON.stringify(this.logData, null, 2)
            );
            console.log(`[seed-it] Debug log saved to ${this.outputPath}`);
        } catch (e) {
            console.error('[seed-it] Failed to save debug log:', e);
        }
    }
}
