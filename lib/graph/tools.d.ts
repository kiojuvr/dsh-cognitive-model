import { type Context } from '../cordis.js';
import { GraphService } from './service.js';
import type { DirectoryResolver } from '@kioju/dsh-cognitive-core';
export declare function registerGraphTools(ctx: Context, service: GraphService, directoryOf: DirectoryResolver): () => void;
