import { type Context } from '../cordis.js';
import { GraphService } from './service.js';
import type { DirectoryResolver } from 'dsh-cognitive-core';
export declare function registerGraphTools(ctx: Context, service: GraphService, directoryOf: DirectoryResolver): () => void;
