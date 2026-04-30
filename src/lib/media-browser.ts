export type MediaKind = "image" | "video";
export type SortKey = "name" | "date" | "size";

export type TreeVisibleEntry =
  | {
      type: "folder";
      key: string;
      path: string;
      depth: number;
      canExpand: boolean;
      isExpanded: boolean;
    }
  | {
      type: "file";
      key: string;
      id: string;
      path: string;
      parentPath: string;
      depth: number;
    };

export type ExplorerSelection =
  | {
      type: "folder";
      path: string;
    }
  | {
      type: "file";
      id: string;
      parentPath: string;
    };

export type MediaItem = {
  id: string;
  kind: MediaKind;
  name: string;
  path: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  modifiedMs: number;
};

export type ScanResult = {
  rootPath: string;
  rootName: string;
  items: MediaItem[];
};

export type FolderTreeNode = {
  path: string;
  name: string;
  depth: number;
  itemCount: number;
  coverPath: string | null;
  children: string[];
};

const NATURAL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function parentFolderPath(relativePath: string) {
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex >= 0 ? relativePath.slice(0, slashIndex) : "";
}

export function compareNaturalText(a: string, b: string) {
  return NATURAL_NAME_COLLATOR.compare(a, b);
}

export function sortMediaItems(items: MediaItem[], sortKey: SortKey) {
  const next = [...items];
  next.sort((a, b) => {
    switch (sortKey) {
      case "name":
        return compareNaturalText(a.name, b.name) || compareNaturalText(a.ext, b.ext);
      case "size":
        return b.sizeBytes - a.sizeBytes;
      case "date":
      default:
        return b.modifiedMs - a.modifiedMs;
    }
  });
  return next;
}

export function filterMediaItems(
  items: MediaItem[],
  options: {
    folderPath?: string;
    kindFilter: "all" | MediaKind;
    query: string;
  },
) {
  const normalizedQuery = options.query.trim().toLowerCase();
  const folderPrefix = options.folderPath ? `${options.folderPath}/` : "";
  const next: MediaItem[] = [];

  for (const item of items) {
    if (folderPrefix && !item.relativePath.startsWith(folderPrefix)) {
      continue;
    }
    if (options.kindFilter !== "all" && item.kind !== options.kindFilter) {
      continue;
    }
    if (
      normalizedQuery &&
      !item.name.toLowerCase().includes(normalizedQuery) &&
      !item.relativePath.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }
    next.push(item);
  }

  return next;
}

export function buildFilesByFolder(items: MediaItem[]) {
  const next = new Map<string, MediaItem[]>();

  for (const item of items) {
    const folderPath = parentFolderPath(item.relativePath);
    const bucket = next.get(folderPath) ?? [];
    bucket.push(item);
    next.set(folderPath, bucket);
  }

  return next;
}

export function buildFolderTree(rootFolderName: string, items: MediaItem[]) {
  const nodes = new Map<string, FolderTreeNode>();
  const childSets = new Map<string, Set<string>>();

  nodes.set("", {
    path: "",
    name: rootFolderName || "Root",
    depth: 0,
    itemCount: 0,
    coverPath: null,
    children: [],
  });

  for (const item of items) {
    const parentPath = parentFolderPath(item.relativePath);
    const segments = parentPath ? parentPath.split("/") : [];
    let currentPath = "";

    nodes.get("")!.itemCount += 1;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!nodes.has(nextPath)) {
        nodes.set(nextPath, {
          path: nextPath,
          name: segment,
          depth: index + 1,
          itemCount: 0,
          coverPath: null,
          children: [],
        });
      }

      const parentNode = nodes.get(currentPath);
      const knownChildren = childSets.get(currentPath) ?? new Set<string>();
      if (!childSets.has(currentPath)) {
        childSets.set(currentPath, knownChildren);
      }
      if (parentNode && !knownChildren.has(nextPath)) {
        knownChildren.add(nextPath);
        parentNode.children.push(nextPath);
      }

      nodes.get(nextPath)!.itemCount += 1;
      currentPath = nextPath;
    }

    if (
      item.kind === "image" &&
      !parentPath &&
      rootFolderName &&
      !nodes.get("")?.coverPath &&
      item.name.toLowerCase() === rootFolderName.toLowerCase()
    ) {
      nodes.get("")!.coverPath = item.path;
    }

    if (item.kind === "image" && parentPath) {
      const folderNode = nodes.get(parentPath);
      if (
        folderNode &&
        !folderNode.coverPath &&
        item.name.toLowerCase() === folderNode.name.toLowerCase()
      ) {
        folderNode.coverPath = item.path;
      }
    }
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => {
      const aNode = nodes.get(a);
      const bNode = nodes.get(b);
      return compareNaturalText(aNode?.name ?? "", bNode?.name ?? "");
    });
  }

  return nodes;
}

export function buildVisibleTreeEntries(
  nodePath: string,
  nodes: Map<string, FolderTreeNode>,
  expandedPaths: Set<string>,
  folderFiles: Map<string, MediaItem[]>,
  depth = 0,
): TreeVisibleEntry[] {
  const node = nodes.get(nodePath);
  if (!node) return [];

  const files = folderFiles.get(node.path) ?? [];
  const canExpand = node.children.length > 0 || files.length > 0;
  const isExpanded = expandedPaths.has(node.path);
  const entries: TreeVisibleEntry[] = [
    {
      type: "folder",
      key: `folder:${node.path}`,
      path: node.path,
      depth,
      canExpand,
      isExpanded,
    },
  ];

  if (!isExpanded) {
    return entries;
  }

  for (const file of files) {
    entries.push({
      type: "file",
      key: `file:${file.id}`,
      id: file.id,
      path: file.path,
      parentPath: node.path,
      depth: depth + 1,
    });
  }

  for (const childPath of node.children) {
    entries.push(
      ...buildVisibleTreeEntries(childPath, nodes, expandedPaths, folderFiles, depth + 1),
    );
  }

  return entries;
}

export function findMediaById(items: MediaItem[], id: string | null) {
  return id ? items.find((item) => item.id === id) ?? null : null;
}

export function findMediaByPath(items: MediaItem[], path: string | null) {
  return path ? items.find((item) => item.path === path) ?? null : null;
}
