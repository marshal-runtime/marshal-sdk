export type CoreSlotValues = Readonly<Record<string, string>>;
/**
 * Fills a template's `⟦id⟧` spans. Per id: the host's value if it gave one, else the opted-in tool pack
 * text, else the neutral default, else an empty string.
 */
export declare function renderTemplate(template: string, options: {
    slots?: CoreSlotValues;
    packs?: readonly string[];
    variant: string;
}): string;
/** Ids of every host-dependent span in a template. */
export declare function templateSlotIds(template: string): string[];
//# sourceMappingURL=render.d.ts.map