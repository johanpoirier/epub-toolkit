const {isEmpty} = require('./utils');

module.exports = function parse(tocDocument) {
  let items;

  const navEntryPoint = tocDocument('navMap');
  if (isEmpty(navEntryPoint)) {
    // ePub 3
    items = parseNavItem(tocDocument('nav[epub\\:type="toc"] > ol > li').first(), 'li', []);
  } else {
    // ePub 2
    items = parseNavItem(tocDocument('navMap > navPoint').first(), 'navPoint', []);
  }

  setPositions(items, 1, 0);

  return items;
};

function parseNavItem(item, tagName, items, parent) {
  let tocItem;
  const childNodes = item.children();
  if (!isEmpty(childNodes)) {
    if (tagName === 'li') {
      tocItem = extractNavLiInfos(item, parent);
    } else {
      tocItem = extractNavPointInfos(item, parent);
    }

    // parsing first child and its siblings
    const childItems = item.children(tagName);
    if (!isEmpty(childItems)) {
      tocItem.items = parseNavItem(childItems.first(), tagName, [], tocItem);
    }

    tocItem.endPoint = (!tocItem.items || tocItem.items.length === 0);

    items.push(tocItem);
  }

  // next nav item
  const nextItem = item.next();
  if (!isEmpty(nextItem)) {
    parseNavItem(nextItem, tagName, items, parent);
  }

  return items;
}

function extractNavLiInfos(item, parent) {
  const link = item.children('a');
  return {
    label: link.text().trim(),
    href: link.attr('href').trim(),
    parent: parent ? { href: parent.href, label: parent.label, parent: parent.parent } : false
  };
}

function extractNavPointInfos(item, parent) {
  const navLabel = item.children('navLabel');
  return {
    label: navLabel ? navLabel.text().trim() : item.attr('id'),
    href: item.children('content').attr('src').trim(),
    parent: parent ? { href: parent.href, label: parent.label, parent: parent.parent } : false
  };
}

function setPositions(items, level, endpoints) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    item.level = level;
    if (item.endPoint) {
      endpoints += 1;
      item.position = endpoints;
    } else {
      endpoints = setPositions(item.items, level + 1, endpoints);
    }
  }
  return endpoints;
}
