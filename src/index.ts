import { DiagnosticSeverity, DwgType } from "albatros/enums";

declare interface Rule3d {
    filter: string;
    field: string;
    tolerance: number;
}

declare interface LayerDiagnostic extends Diagnostic {
    ctx: Context;
    layer: DwgLayer;
}

function activateDiagnostic(diagnostic: Diagnostic) {
    const ld = diagnostic as LayerDiagnostic;
    ld.ctx.manager.eval('ru.albatros.wdx/wdx:layers:activate', {
        layer: ld.layer,
    });
    ld.ctx.manager.broadcast('wdx:onView:layers:select' as Broadcast, {
        layers: [ld.layer],
        cadview: ld.ctx.cadview,
    });
}

export default {
    volume3d(ctx: Context): DiagnosticRule<Rule3d> {
        return {
            async createRule() {
                return {
                    filter: '$type_3 = SmdxVolume3d',
                    field: 'volume',
                    tolerance: 1,
                }
            },
            async execute(app, rule, diagnostics, _progress) {
                const drawing = app.model as Drawing;
                if (drawing !== undefined) {
                    const layers = drawing.filterLayers(rule.field, true);
                    const volumes = new Map<DwgLayer, number>();
                    drawing.layouts.model?.walk(e => {
                        if ((e.type === DwgType.model3d) && (e.layer !== undefined)) {
                            if (layers.has(e.layer)) {
                                const volume = volumes.get(e.layer) ?? 0;
                                const v = (e as DwgModel3d).volume;
                                volumes.set(e.layer, volume + v);
                            }
                        }
                        return false;
                    });
                    drawing.attachments.forEach(attachment => {
                        const model = attachment.model;
                        if (model !== undefined) {
                            model.layouts.model?.walk(e => {
                                if ((e.type === DwgType.model3d) && (e.layer !== undefined)) {
                                    if (layers.has(e.layer)) {
                                        const volume = volumes.get(e.layer) ?? 0;
                                        const v = (e as DwgModel3d).volume;
                                        volumes.set(e.layer, volume + v);
                                    }
                                }
                                return false;
                            });
                        }
                    });
                    const messages: Record<string, LayerDiagnostic[]> = {};
                    if (layers.size === 0) {
                        const modelName = drawing.layers.layer0?.modelName ?? '';
                        messages[modelName] = [{
                            message: ctx.tr('Не найдены подходящие объекты'),
                            severity: DiagnosticSeverity.Warning,
                            tooltip: ctx.tr('Не удалось найти объекты, удовлетворяющие заданному фильтру'),
                            layer: drawing.layers.layer0!,
                            ctx,
                        }];
                    }
                    layers.forEach(layer => {
                        const modelName = layer.modelName;
                        let collection = messages[modelName];
                        if (collection === undefined) {
                            messages[modelName] = collection = [];
                        }
                        const property = layer.typedValue(rule.field);
                        if ((property === undefined) || (typeof property.$value !== 'number')) {
                            collection.push({
                                message: ctx.tr('Свойство "{0}" не найдено', rule.field),
                                severity: DiagnosticSeverity.Error,
                                source: `${layer.layer?.name}/${layer.name}`,
                                layer,
                                ctx,
                                activation: activateDiagnostic,
                            });
                        } else {
                            const volume = volumes.get(layer);
                            if (volume === undefined) {
                                collection.push({
                                    message: ctx.tr('Не удалось вычислить объем'),
                                    severity: DiagnosticSeverity.Error,
                                    source: `${layer.layer?.name}/${layer.name}`,
                                    tooltip: ctx.tr('Не удалось вычислить объем тела. 3d тела не найдены.'),
                                    layer,
                                    ctx,
                                    activation: activateDiagnostic,
                                });
                            } else {
                                const tolerance = Math.abs((volume - property.$value!) / volume) * 100;
                                if (tolerance > rule.tolerance) {
                                    collection.push({
                                        message: ctx.tr('Неверное значение объема. Отклонение {0}%', tolerance.toFixed(0)),
                                        severity: DiagnosticSeverity.Error,
                                        source: `${layer.layer?.name}/${layer.name}`,
                                        tooltip: ctx.tr('Объем тела не соответствует заданному значению'),
                                        layer,
                                        ctx,
                                        activation: activateDiagnostic,
                                    });
                                }
                            }
                        }
                    });
                    for (const uri in messages) {
                        diagnostics.set(uri, messages[uri]);
                    }
                }
            },
        }
    },
    'property:tolerance': (e: Context & ManifestPropertyProvider): ObjectPropertyProvider => {
        return {
            getProperties(objects: unknown[]) {
                const field = e.field;
                if (field === undefined) {
                    return [];
                }
                return [{
                    id: `tolerance-${field}`,
                    label: e.label ?? field,
                    description: e.description,
                    group: e.group,
                    value() {
                        const value = (objects[0] as any)[field];
                        for (let i = 1; i < objects.length; i++) {
                            if (value !== (objects[i] as any)[field]) {
                                return {
                                    label: e.tr('**Различные**'),
                                    suffix: '%',
                                }
                            }
                        }
                        return {
                            label: value,
                            suffix: '%',
                        }
                    },
                    editor() {
                        return {
                            type: "editbox",
                            commit(value) {
                                if (value === undefined) {
                                    return;
                                }
                                const number = parseFloat(value);
                                for (const object of objects) {
                                    try {
                                        (object as any)[field] = number;
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }
                            },
                            validate(value) {
                                if (value === '') {
                                    return e.tr('Поле не может быть пустым');
                                }
                                const number = parseFloat(value);
                                if (!isFinite(number)) {
                                    return e.tr('Значение должно быть числом');
                                }
                                if (number < 0 || number > 100) {
                                    return e.tr('Значение должно быть в диапазоне от 0 до 100');
                                }
                            },
                        }
                    },
                }];
            },
        }
    },
    'property:field': (e: Context & ManifestPropertyProvider): ObjectPropertyProvider => {
        return {
            getProperties(objects: Rule3d[]) {
                return [{
                    id: 'volume3d-field',
                    label: e.label!,
                    description: e.description,
                    group: e.group,
                    value() {
                        const value = objects[0].field;
                        for (let i = 1; i < objects.length; i++) {
                            if (value !== objects[i].field) {
                                return {
                                    label: e.tr('**Различные**'),
                                }
                            }
                        }
                        return {
                            label: value,
                        }
                    },
                    editor() {
                        return {
                            type: "editbox",
                            buttons: e.app ? [
                                {
                                    label: "...",
                                    icon: "more_horiz",
                                }
                            ] : [],
                            async onDidTriggerItemButton() {
                                const layers = e.cadview?.layer.drawing?.layout.drawing?.filterLayers(objects[0].filter, true) ?? new Set();
                                const map = new Map<string, string>();
                                for (const layer of layers) {
                                    const typed = layer.typedProperties();
                                    for (const key in typed) {
                                        if (!key.startsWith('$')) {
                                            const value = layer.typedValue(key);
                                            map.set(key, value.$name ?? key);
                                        }
                                    }
                                }
                                const items = [...map.keys()].map(key => {
                                    return {
                                        key,
                                        label: map.get(key)!,
                                        description: key,
                                    }
                                });
                                const item = await e.showQuickPick(items, {
                                    placeHolder: e.tr('Выберите поле'),
                                });
                                for (const object of objects) {
                                    try {
                                        object.field = item.key;
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }
                            },
                            commit(value) {
                                if (value === undefined) {
                                    return;
                                }
                                for (const object of objects) {
                                    try {
                                        object.field = value;
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }
                            },
                        }
                    },
                }];
            },
        }
    },
}