import * as _debug from 'debug'
import * as fs from 'fs'
import { dirname } from 'path'

export const debug = _debug('IDE:main_process:git')

export interface IDisposable {
    dispose(): void;
}

export function dispose<T extends IDisposable>(disposables: T[]): T[] {
    disposables.forEach((d) => d.dispose());
    return [];
}

export function toDisposable(dispose: () => void): IDisposable {
    return { dispose };
}

export function combinedDisposable(disposables: IDisposable[]): IDisposable {
    return toDisposable(() => dispose(disposables));
}

export const EmptyDisposable = toDisposable(() => null);

export function assign<T>(destination: T, ...sources: any[]): T {
    for (const source of sources) {
        Object.keys(source).forEach ((key) => destination[key] = source[key])
    }
    return destination
}

export function uniqBy<T>(arr: T[], fn: (el: T) => string): T[] {
    const seen: Set<string> = new Set()
    return arr.filter((el) => {
        const key = fn(el)
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    })
}

export function groupBy<T>(arr: T[], fn: (el: T) => string): { [key: string]: T[] } {
    return arr.reduce((result, el) => {
        const key = fn(el)
        result[key] = [...(result[key] || []), el]
        return result
    }, Object.create(null))
}

export function denodeify<R>(fn: Function): (...args) => Promise<R> {
    return (...args) => new Promise<R>((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)))
}

export function nfcall<R>(fn: Function, ...args): Promise<R> {
    return new Promise<R>((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)))
}

export async function mkdirp(path: string, mode?: number): Promise<boolean> {
    if (fs.existsSync(path)) {
        const stat = await nfcall<fs.Stats>(fs.stat, path)
        if (stat.isDirectory()) {
            return
        }
        throw new Error(`'${path}' exists and is not a directory.`)
    }
    await mkdirp(dirname(path))
    await nfcall(fs.mkdir, path, mode)
}

export function uniqueFilter<T>(keyFn: (t: T) => string): (t: T) => boolean {
    const seen: Set<string> = new Set()
    return (element) => {
        const key = keyFn(element)
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    }
}

export function find<T>(array: T[], fn: (t: T) => boolean): T | undefined {
    let result: T | undefined
    array.some((e) => {
        if (fn(e)) {
            result = e
            return true
        }
        return false
    })
    return result
}
