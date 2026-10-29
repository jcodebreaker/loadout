// Format integer cents as a price string, like "$1,234.50".
export function formatMoney(cents, currency) {
  var c = currency;
  if (c == undefined) c = 'USD';
  var neg = false;
  if (cents < 0) {
    neg = true;
    cents = -cents;
  }
  var dollars = Math.floor(cents / 100);
  var rest = cents % 100;
  var restStr;
  if (rest < 10) {
    restStr = '0' + rest;
  } else {
    restStr = '' + rest;
  }
  var dollarsStr = '' + dollars;
  var out = '';
  var count = 0;
  for (var i = dollarsStr.length - 1; i >= 0; i--) {
    out = dollarsStr[i] + out;
    count++;
    if (count % 3 == 0 && i != 0) {
      out = ',' + out;
    }
  }
  var sym;
  if (c == 'USD') {
    sym = '$';
  } else if (c == 'EUR') {
    sym = '€';
  } else if (c == 'GBP') {
    sym = '£';
  } else {
    sym = c + ' ';
  }
  var result = sym + out + '.' + restStr;
  if (neg == true) {
    result = '-' + result;
  }
  return result;
}
